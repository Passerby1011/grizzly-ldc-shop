/**
 * 业务编排层：把「路由」和「账本 / 上游」粘起来。
 *
 * 取号全流程（账本铁律 #2）：
 *   1) 按 `maxPrice` 上限**原子预扣**；
 *   2) `getNumber`；
 *   3) 成功 → 写 `Activation` → 按真实成本**退回差额**；失败 → **全额退回**。
 *
 * 取消流程（账本铁律 #3）：`setStatus(8)` 成功后才回补，同时把 `Activation.status` 置 `cancelled`。
 * 回补用条件 UPDATE 抢占，杜绝重复退款。
 */
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "./db";
import { getConfig } from "./config";
import { dec, roundUp2, toStorageString, usdToLdc, type Decimal, type DecimalInput } from "./money";
import { getLedger } from "./ledger";
import {
  GrizzlyApiError,
  GRIZZLY_STATUS,
  getGrizzlyClient,
  getPriceProvider,
  type GrizzlyClient,
  type ParsedStatus,
} from "./grizzly";
import { getLdcClient, type LdcClient } from "./ldc";
import { MAX_FACE_USD, fulfillPaidOrder } from "./pool";
import { checkFaceAmount } from "./face-value";
import { getSiteSettings } from "./settings";
import { badRequest, conflict, notFound, ERROR_CODES, forbidden } from "./http";

/* ------------------------------------------------------------------ */
/* 下单                                                               */
/* ------------------------------------------------------------------ */

export interface CreatePayOrderResult {
  orderId: string;
  outTradeNo: string;
  faceUsd: string;
  amountLdc: string;
  payUrl: string;
}

/** 生成订单号：GS + 时间戳(base36) + 随机 hex，长度受控（≤ 32）。 */
export function generateOutTradeNo(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(5).toString("hex").toUpperCase();
  return `GS${stamp}${random}`;
}

export function orderName(faceUsd: DecimalInput): string {
  return `Grizzly 卡密 $${dec(faceUsd).toFixed(2)}`;
}

/**
 * 给**已有卡密**充值：只创建 pending 订单，钱到账后才加余额（见 fulfillPaidOrder）。
 *
 * 与 createPayOrder 的关系：孪生，但不是同一件事 ——
 *   - 新购：付款后**新建**一张卡密
 *   - 充值：付款后给**已存在**的卡密加余额
 * 所以订单用 kind 区分，且充值订单不绑 keyId（那个字段是 @unique，一卡一单）。
 *
 * 安全：目标卡密必须是**调用方已登录的这张卡**（keyId 由会话得出，不接受前端传 id）。
 * 否则别人可以把余额充到任意卡上，等于替他买单。
 */
export async function createTopupOrder(
  input: { keyId: string; amountUsd: DecimalInput },
  options: { ldc?: LdcClient } = {},
): Promise<CreatePayOrderResult> {
  const config = getConfig();

  const check = checkFaceAmount(input.amountUsd);
  if (!check.ok) throw badRequest(check.reason ?? "金额不合法");
  const amountUsd = check.value;

  const prisma = getPrisma();
  const key = await prisma.cardKey.findUnique({ where: { id: input.keyId } });
  if (!key) throw notFound("卡密不存在");
  if (key.status !== "active") throw conflict(ERROR_CODES.CONFLICT, "该卡密当前不可充值");

  /*
   * 与新购走同一道池容量闸门。
   *
   * 为什么充值也必须拦：充值的钱最终会变成从上游买号的额度，
   * 所以"卖出超过上游余额的承诺"这件事，充值和新购一样会造成。
   * 曾经只有新购有闸门，充值可以直接买下池子装不下的额度 ——
   * 买家付了 LDC，站点欠着兑不出的号，属于负债而非漏洞，但同样要拦。
   */
  await checkTopupPoolCapacity(amountUsd);

  const settings = await getSiteSettings();
  const amountLdc = usdToLdc(amountUsd, settings.rateLdcPerUsd, settings.markupPct);
  const outTradeNo = generateOutTradeNo();
  const name = `卡密充值 ${amountUsd.toFixed(2)}`;

  const order = await prisma.order.create({
    data: {
      outTradeNo,
      name,
      kind: "topup",
      amountLdc: toStorageString(amountLdc),
      faceUsd: toStorageString(amountUsd),
      status: "pending",
      gateway: "epay",
      targetKeyId: key.id,
    },
  });

  const ldc = options.ldc ?? getLdcClient();
  const result = await ldc.createOrder({
    outTradeNo,
    name,
    money: amountLdc,
    notifyUrl: config.notifyUrl,
    returnUrl: `${config.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/shop?topup=${outTradeNo}`,
  });

  if (result.orderNo) {
    await prisma.order.update({ where: { id: order.id }, data: { ldcTradeNo: result.orderNo } });
  }

  return {
    orderId: order.id,
    outTradeNo,
    faceUsd: amountUsd.toFixed(2),
    amountLdc: amountLdc.toFixed(2),
    payUrl: result.payUrl,
  };
}

export async function createPayOrder(
  faceUsdInput: DecimalInput,
  options: { ldc?: LdcClient } = {},
): Promise<CreatePayOrderResult> {
  const config = getConfig();

  /* 金额规则只认一处：0.1 步长 + 上下限。接口层也调同一个函数，避免两边判断不一致 */
  const check = checkFaceAmount(faceUsdInput);
  if (!check.ok) throw badRequest(check.reason ?? "金额不合法");
  const faceUsd = check.value;

  /*
   * 汇率必须从「站点设置」读（DB > 环境变量 > 默认），不能直接用 config。
   * 否则后台改了汇率，首页显示新价而下单按环境变量旧价收费 —— 价格错位。
   */
  const settings = await getSiteSettings();
  const amountLdc = usdToLdc(faceUsd, settings.rateLdcPerUsd, settings.markupPct);
  const outTradeNo = generateOutTradeNo();
  const name = orderName(faceUsd);
  const prisma = getPrisma();

  const order = await prisma.order.create({
    data: {
      outTradeNo,
      name,
      amountLdc: toStorageString(amountLdc),
      faceUsd: toStorageString(faceUsd),
      status: "pending",
      gateway: "epay",
    },
  });

  const ldc = options.ldc ?? getLdcClient();
  const result = await ldc.createOrder({
    outTradeNo,
    name,
    money: amountLdc,
    notifyUrl: config.notifyUrl,
    returnUrl: `${config.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/shop?order=${outTradeNo}`,
  });

  if (result.orderNo) {
    await prisma.order.update({ where: { id: order.id }, data: { ldcTradeNo: result.orderNo } });
  }

  return {
    orderId: order.id,
    outTradeNo,
    faceUsd: faceUsd.toFixed(2),
    amountLdc: amountLdc.toFixed(2),
    payUrl: result.payUrl,
  };
}

/* ------------------------------------------------------------------ */
/* 卡密会话                                                            */
/* ------------------------------------------------------------------ */

export interface CardKeySummary {
  id: string;
  codePrefix: string;
  faceUsd: string;
  balanceUsd: string;
  status: string;
  expiresAt: string | null;
}

export async function loadCardKey(keyId: string): Promise<CardKeySummary | null> {
  const key = await getPrisma().cardKey.findUnique({ where: { id: keyId } });
  if (!key) return null;
  return {
    id: key.id,
    codePrefix: key.codePrefix,
    faceUsd: dec(key.faceUsd.toString()).toFixed(2),
    balanceUsd: dec(key.balanceUsd.toString()).toFixed(2),
    status: key.status,
    expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
  };
}

/** 卡密是否还能用（active 且未过期）。 */
/**
 * 卡密能否**取号**（消耗余额）。
 *
 * 要求 status = active。余额扣到 0 时 ledger 会把状态改成 depleted，
 * 此时不能再取号 —— 但**仍应能登录**（见 canLogin），否则用户无法充钱自救。
 */
export function isKeyUsable(key: { status: string; expiresAt: Date | null }): boolean {
  if (key.status !== "active") return false;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

/**
 * 卡密能否**登录**（进接码台看余额 / 历史 / 充值）。
 *
 * 比 isKeyUsable 宽：depleted（余额用光）也放行。
 *
 * 为什么必须这样：以前登录判据直接用了 isKeyUsable，于是余额扣到 0 的瞬间
 * 状态变 depleted → 登录被拒 → 而充值接口又要求先登录 → 用户被锁在门外，
 * 想充钱都进不来。这是死路，必须留出自救通道。
 *
 * 只有 revoked（作废）和已过期才真正禁止登录。
 */
export function canLogin(key: { status: string; expiresAt: Date | null }): boolean {
  if (key.status === "revoked") return false;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* 取号                                                               */
/* ------------------------------------------------------------------ */

export interface StartActivationInput {
  keyId: string;
  service: string;
  country: string;
  /* 覆盖估价（管理端/测试用），一般留空走 PriceProvider */
  priceUsd?: DecimalInput;
  grizzly?: GrizzlyClient;
}

export interface StartActivationResult {
  activationId: string;
  phone: string;
  service: string;
  country: string;
  reservedUsd: string;
  costUsd: string;
  priceSource: string;
  balanceUsd: string;
}

export async function startActivation(input: StartActivationInput): Promise<StartActivationResult> {
  const prisma = getPrisma();
  const ledger = getLedger();
  const grizzly = input.grizzly ?? getGrizzlyClient();

  const key = await prisma.cardKey.findUnique({ where: { id: input.keyId } });
  if (!key) throw notFound("卡密不存在");
  if (!isKeyUsable(key)) {
    /* 区分"没钱"和"卡坏了"：前者能让用户自己充钱解决，别让他一脸懵 */
    if (key.status === "depleted") {
      throw forbidden("卡密余额已用完，请先充值再取号");
    }
    throw forbidden("卡密不可用（已过期或已失效）");
  }

  /*
   * priceUsd 覆盖分支只保留给服务端内部调用（管理端/测试）。
   * 公开 HTTP 路由已不再接受价格入参（见 /api/sms/get），
   * 且下方 observe 会跳过 override 来源，避免污染全局价格缓存。
   */
  const quote = input.priceUsd
    ? { service: input.service, country: input.country, priceUsd: dec(input.priceUsd), source: "override" as const }
    : await getPriceProvider().quote(input.service, input.country);
  const cost = quote.priceUsd;
  /* 上限预扣：多留一分钱，避免上游报价取整后刚好超限。 */
  const cap = roundUp2(cost);
  if (cap.lte(0)) throw badRequest("估价异常：必须大于 0");

  /* 1) 原子预扣（余额不足直接 402） */
  await ledger.debitOrThrow(undefined, input.keyId, cap, "get_number", null);

  /* 2) 取号；失败全额退回 */
  let number: { id: string; phone: string };
  try {
    number = await grizzly.getNumber({ service: input.service, country: input.country, maxPrice: cap });
  } catch (error) {
    await ledger.creditOrThrow(undefined, input.keyId, cap, "cancel_refund", null);
    throw error;
  }

  /* 3) 写 Activation（costUsd 先记为估价，取消/完成都以此为准）；写失败同样全额退回 */
  let activation;
  try {
    activation = await prisma.activation.create({
      data: {
        keyId: input.keyId,
        grizzlyId: number.id,
        service: input.service,
        country: input.country,
        phone: number.phone,
        reservedUsd: toStorageString(cap),
        costUsd: toStorageString(cost),
        status: "waiting",
      },
    });
  } catch (error) {
    await ledger.creditOrThrow(undefined, input.keyId, cap, "cancel_refund", null);
    throw error;
  }
  await attachLedgerRef(input.keyId, activation.id);

  /* 4) 差额退回（cap → cost） */
  const settled = await ledger.settleReservation(undefined, input.keyId, cap, cost, activation.id);

  /*
   * 回填价格缓存。
   *
   * 只在**服务端自己估价**时才回填：override 分支的价格来自调用方
   * （历史上就是被滥用的那条路），绝不能写进全局共享的 PriceCache，
   * 否则一个人的取号会改写所有人的售价。
   *
   * 注：这个数本质是"估价"而非上游真实成交成本（上游不返回成交价），
   * 所以它只是让下次报价更接近，不参与任何资金结算。
   */
  if (quote.source !== "override") {
    try {
      await getPriceProvider().observe(input.service, input.country, cost);
    } catch {
      // 缓存回填失败不影响取号
    }
  }

  return {
    activationId: activation.id,
    phone: number.phone,
    service: input.service,
    country: input.country,
    reservedUsd: cap.toFixed(2),
    costUsd: cost.toFixed(2),
    priceSource: quote.source,
    balanceUsd: settled.balanceAfter.toFixed(2),
  };
}

async function attachLedgerRef(keyId: string, activationId: string): Promise<void> {
  const prisma = getPrisma();
  const last = await prisma.keyLedger.findFirst({
    where: { keyId, reason: "get_number", refId: null },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    await prisma.keyLedger.update({ where: { id: last.id }, data: { refId: activationId } });
  }
}

/* ------------------------------------------------------------------ */
/* 轮询状态                                                            */
/* ------------------------------------------------------------------ */

export interface PollActivationResult {
  activationId: string;
  status: "waiting" | "ok" | "cancelled" | "expired";
  code: string | null;
  smsText: string | null;
  phone: string;
  hint: string | null;
  costUsd: string | null;
  balanceUsd: string | null;
  /** 距「可取消」的剩余秒数（<=0 表示现在就能取消）。 */
  cancelAvailableInSeconds: number;
  /** 可取消的时间点（ISO 时间戳）。 */
  cancelLockedUntil: string;
  /** true = 这道锁来自"上次取消失败"的重试冷却，不是取号后的初始锁。 */
  cancelRetryLocked: boolean;
  /**
   * 距「超时自动回收」的剩余秒数；null = 未开启自动回收（autoCancelMinutes = 0）。
   * 从**本号码自己的取号时间**算起，与巡检频率无关。
   */
  autoCancelInSeconds: number | null;
  /** 自动回收时间点（ISO）；null = 未开启。 */
  autoCancelAt: string | null;
}

export async function pollActivation(input: {
  keyId: string;
  activationId: string;
  grizzly?: GrizzlyClient;
}): Promise<PollActivationResult> {
  const prisma = getPrisma();
  const grizzly = input.grizzly ?? getGrizzlyClient();
  const activation = await prisma.activation.findUnique({ where: { id: input.activationId } });
  if (!activation || activation.keyId !== input.keyId) throw notFound("激活记录不存在");

  /* 超时回收阈值：每次都现取（有 30s 缓存），后台改了立刻反映到倒计时 */
  const pollSettings = await getSiteSettings();
  const autoCancelMinutes = pollSettings.autoCancelMinutes;
  /*
   * 取消锁定时长同样走设置（DB > env > 默认）。
   * 曾经这里只读环境变量，后台改了不生效 —— 见 cancelWindow 的说明。
   */
  const lockSeconds = Number.isFinite(pollSettings.cancelLockSeconds)
    ? pollSettings.cancelLockSeconds
    : getConfig().CANCEL_LOCK_SECONDS;

  /*
   * 精确回收：买家在等码时会每 4 秒轮询一次，所以**每次轮询都按号龄判一次**。
   * 号龄 = now - 本号码自己的 createdAt，与巡检频率无关 —— 这才是
   * 「从激活那一刻往后推 N 分钟」的正确落点。
   *
   * 上游硬约束：号码「有效期起只有 20 分钟」，官方 FAQ 说购买后 20 分钟内才可退款。
   * 所以绝不能出现「16 分钟 + 一个巡检间隔」的漂移，否则越过红线就退不回钱。
   */
  if (
    activation.status === "waiting" &&
    Number.isFinite(autoCancelMinutes) &&
    autoCancelMinutes > 0 &&
    Date.now() >= activation.createdAt.getTime() + autoCancelMinutes * 60_000
  ) {
    await recycleOneActivation(activation.id);
    const after = await prisma.activation.findUnique({ where: { id: activation.id } });
    if (after) return toPollResult(after, "等待超时，号码已自动回收", autoCancelMinutes, lockSeconds);
  }

  if (activation.status === "ok") {
    return toPollResult(activation, null, autoCancelMinutes, lockSeconds);
  }
  if (activation.status === "cancelled" || activation.status === "expired") {
    return toPollResult(activation, null, autoCancelMinutes, lockSeconds);
  }

  const parsed: ParsedStatus = await grizzly.getStatus(activation.grizzlyId);
  await prisma.activation.update({
    where: { id: activation.id },
    data: { lastPolledAt: new Date() },
  });

  switch (parsed.state) {
    case "OK": {
      /*
       * 关键：先「条件认领」再通知上游，顺序不能反。
       *
       * 这里曾经是「先 setStatus(6) 扣费、再无条件下发验证码」，存在竞态漏洞：
       * 轮询读到 waiting → 查上游拿到码 → 期间用户点了取消（已退款、本地置 cancelled）
       * → 本处无条件 update 又把状态写回 ok 并下发验证码。
       * 结果：用户**同时**拿到退款和验证码，卖家既付了上游成本又退了款。
       *
       * 现在只有「仍是 waiting」时才能认领成功；认领失败说明已被取消/回收，
       * 那就绝不通知上游、绝不下发验证码。
       */
      const claimed = await prisma.activation.updateMany({
        where: { id: activation.id, status: "waiting" },
        data: { status: "ok", code: parsed.code, closedAt: new Date() },
      });
      if (claimed.count === 0) {
        const latest = await prisma.activation.findUnique({ where: { id: activation.id } });
        return toPollResult(latest ?? activation, "该号码已取消/回收，不再下发验证码（费用按规则不退，请联系卖家）", autoCancelMinutes, lockSeconds);
      }
      /* 认领成功后才通知上游完成（正式扣费）。失败不回滚：码已经给用户了。 */
      try {
        await grizzly.setStatus(activation.grizzlyId, GRIZZLY_STATUS.ACTIVATION);
      } catch {
        // 忽略：状态已经是 OK
      }
      const smsText = await fetchSmsText(grizzly, activation.grizzlyId);
      const updated = await prisma.activation.update({
        where: { id: activation.id },
        data: { smsText },
      });
      return toPollResult(updated, null, autoCancelMinutes, lockSeconds);
    }
    case "CANCEL": {
      /* 上游取消 → 等价于取消回补 */
      const refund = await cancelActivationInternal(activation.id, "upstream");
      const latest = await prisma.activation.findUnique({ where: { id: activation.id } });
      return { ...toPollResult(latest ?? activation, "上游已取消，余额已回补", autoCancelMinutes, lockSeconds), balanceUsd: refund.balanceUsd };
    }
    case "WAIT_RETRY":
      return toPollResult(activation, "等待重发验证码", autoCancelMinutes, lockSeconds);
    case "WAIT_RESEND":
      return toPollResult(activation, "已请求重发", autoCancelMinutes, lockSeconds);
    case "WAIT_CODE":
      return toPollResult(activation, null, autoCancelMinutes, lockSeconds);
    default:
      return toPollResult(activation, "上游返回未知状态", autoCancelMinutes, lockSeconds);
  }
}

async function fetchSmsText(grizzly: GrizzlyClient, grizzlyId: string): Promise<string | null> {
  try {
    const json = await grizzly.getStatusV2(grizzlyId);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      for (const field of ["sms", "text", "message"]) {
        const value = record[field];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
      }
    }
  } catch {
    // 短信全文拿不到不影响主流程
  }
  return null;
}

function toPollResult(
  activation: {
    id: string;
    status: string;
    code: string | null;
    smsText: string | null;
    phone: string;
    costUsd: unknown;
    reservedUsd: unknown;
    createdAt: Date;
    /* 上次取消失败后的重试锁；没有则为 null */
    cancelRetryAt?: Date | null;
  },
  hint: string | null,
  autoCancelMinutes = 0,
  cancelLockSeconds?: number,
): PollActivationResult {
  const cost = activation.costUsd ?? activation.reservedUsd;
  const window = cancelWindow(activation.createdAt, activation.cancelRetryAt ?? null, cancelLockSeconds);
  const auto = autoCancelWindow(activation.createdAt, autoCancelMinutes);
  return {
    activationId: activation.id,
    status: activation.status as PollActivationResult["status"],
    code: activation.code,
    smsText: activation.smsText,
    phone: activation.phone,
    hint,
    costUsd: cost === null || cost === undefined ? null : dec(String(cost)).toFixed(2),
    balanceUsd: null,
    cancelAvailableInSeconds: window.cancelAvailableInSeconds,
    cancelLockedUntil: window.cancelLockedUntil,
    cancelRetryLocked: window.cancelRetryLocked,
    autoCancelInSeconds: auto.autoCancelInSeconds,
    autoCancelAt: auto.autoCancelAt,
  };
}

/**
 * 取消解锁时刻 = max(取号时间 + CANCEL_LOCK_SECONDS, 上次失败的重试锁)。
 *
 * 两道锁：
 *   ① 初始锁：取号后 CANCEL_LOCK_SECONDS 内不给取消（上游本来就会拒）。
 *   ② 重试锁：第一次被上游拒（EARLY_CANCEL_DENIED）后，再锁 max(重试秒数)，
 *      到点提示买家再试。因为上游解锁时机不可预测（实测 64s~334s 浮动），
 *      既不能让他连点刷上游，也不能骗他说"马上就好"。
 *
 * 全部由服务端根据库里的时间戳算，刷新页面/换设备都不会丢。
/**
 * 超时回收窗口：从**本号码的取号时间**算起 autoCancelMinutes 分钟。
 *
 * 注意与「巡检频率」是两回事：巡检只是"多久去看一眼"，判定永远按号龄算。
 * 号龄到点后，最多再等一个巡检间隔就会被回收。
 */
function autoCancelWindow(
  createdAt: Date,
  minutes: number,
): { autoCancelInSeconds: number | null; autoCancelAt: string | null } {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { autoCancelInSeconds: null, autoCancelAt: null };
  }
  const at = createdAt.getTime() + minutes * 60_000;
  return {
    autoCancelInSeconds: Math.max(0, Math.ceil((at - Date.now()) / 1000)),
    autoCancelAt: new Date(at).toISOString(),
  };
}

function cancelWindow(
  createdAt: Date,
  cancelRetryAt: Date | null = null,
  cancelLockSeconds: number = getConfig().CANCEL_LOCK_SECONDS,
): { cancelAvailableInSeconds: number; cancelLockedUntil: string; cancelRetryLocked: boolean } {
  /*
   * 锁定时长优先取后台设置（DB > 环境变量 > 默认）。
   *
   * 这里曾经直接读 getConfig()（纯环境变量），导致后台把「取消锁定」
   * 从 90 改成别的值后界面显示新值、实际仍按 90 秒执行 ——
   * 与 safetyBufferUsd 之前那个"改了不生效"是同一类病。
   * 调用方在 pollActivation 里已经 await 了 getSiteSettings()，顺手传进来。
   */
  const lockSeconds = Number.isFinite(cancelLockSeconds)
    ? cancelLockSeconds
    : getConfig().CANCEL_LOCK_SECONDS;
  const initialMs = createdAt.getTime() + lockSeconds * 1000;
  const retryMs = cancelRetryAt ? cancelRetryAt.getTime() : 0;
  const lockUntilMs = Math.max(initialMs, retryMs);
  const now = Date.now();
  return {
    cancelAvailableInSeconds: Math.max(0, Math.ceil((lockUntilMs - now) / 1000)),
    cancelLockedUntil: new Date(lockUntilMs).toISOString(),
    /* true = 当前这道锁是"上次取消失败"留下的，前端据此换话术 */
    cancelRetryLocked: retryMs > initialMs && now < retryMs,
  };
}

/* ------------------------------------------------------------------ */
/* 取消                                                               */
/* ------------------------------------------------------------------ */

export interface CancelActivationResult {
  activationId: string;
  status: "cancelled";
  refundedUsd: string;
  balanceUsd: string | null;
}

export async function cancelActivation(input: {
  keyId: string;
  activationId: string;
  grizzly?: GrizzlyClient;
}): Promise<CancelActivationResult> {
  const prisma = getPrisma();
  const activation = await prisma.activation.findUnique({ where: { id: input.activationId } });
  if (!activation || activation.keyId !== input.keyId) throw notFound("激活记录不存在");
  if (activation.status === "cancelled") {
    return {
      activationId: activation.id,
      status: "cancelled",
      refundedUsd: "0.00",
      balanceUsd: null,
    };
  }
  if (activation.status !== "waiting") {
    throw conflict(ERROR_CODES.CONFLICT, `激活状态为 ${activation.status}，无法取消`);
  }

  /* 本地闸门：初始锁 或 上次失败的重试锁 未到期 → 直接拒绝，不打扰上游。 */
  const settings = await getSiteSettings();
  /* 取后台设置（DB > env > 默认），不是只读环境变量 */
  const lockSeconds = Number.isFinite(settings.cancelLockSeconds)
    ? settings.cancelLockSeconds
    : getConfig().CANCEL_LOCK_SECONDS;
  const initialMs = activation.createdAt.getTime() + lockSeconds * 1000;
  const retryMs = activation.cancelRetryAt ? activation.cancelRetryAt.getTime() : 0;
  const lockUntil = Math.max(initialMs, retryMs);
  if (Date.now() < lockUntil) {
    const wait = Math.ceil((lockUntil - Date.now()) / 1000);
    /* 重试锁生效时给更贴切的话术：不是"刚取号"，而是"上游还没解锁" */
    const isRetryLock = retryMs > initialMs && Date.now() < retryMs;
    throw conflict(
      ERROR_CODES.CONFLICT,
      isRetryLock
        ? `上游还未解锁取消，请等待倒计时结束后再点（约 ${Math.ceil(wait / 60)} 分钟）`
        : `取号后需等待 ${lockSeconds} 秒才能取消`,
      { retryAfterSeconds: wait, retryLock: isRetryLock },
    );
  }

  const grizzly = input.grizzly ?? getGrizzlyClient();
  /* 铁律 #3：setStatus(8) 成功之后才回补 */
  try {
    await grizzly.setStatus(activation.grizzlyId, GRIZZLY_STATUS.CANCEL);
  } catch (error) {
    /* 上游报错时先问清楚状态，避免「其实已取消却把用户的钱扣着」 */
    const state = await grizzly.getStatus(activation.grizzlyId).catch(() => null);
    if (state?.state === "OK") {
      await prisma.activation.update({
        where: { id: activation.id },
        data: { status: "ok", code: state.code, closedAt: new Date() },
      });
      throw conflict(ERROR_CODES.CONFLICT, "上游已完成激活，无法取消");
    }
    if (state?.state !== "CANCEL") {
      /*
       * 上游仍拒绝过早取消 → 落一个"重试锁"，让买家等一会儿再点。
       *
       * 为什么不能只回个 15 秒：上游解锁取消的时机不可预测（实测取消窗口
       * 64s~334s 浮动，按供应商/服务变），回 15 秒会让买家连点十几次全失败，
       * 既刷上游又像"按钮坏了"。锁 2~3 分钟并明确告知，体验和上游压力都合理。
       */
      if (error instanceof GrizzlyApiError && error.code === "EARLY_CANCEL_DENIED") {
        const configured = Number(settings.cancelRetrySeconds);
        const retrySeconds = Math.max(
          30,
          Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_CANCEL_RETRY_SECONDS,
        );
        const retryAt = new Date(Date.now() + retrySeconds * 1000);
        await prisma.activation.update({
          where: { id: activation.id },
          data: {
            cancelRetryAt: retryAt,
            cancelAttempts: { increment: 1 },
          },
        });
        const minutes = Math.max(1, Math.round(retrySeconds / 60));
        throw conflict(
          ERROR_CODES.CONFLICT,
          `上游还没解锁取消，约 ${minutes} 分钟后可以再试一次`,
          {
            retryAfterSeconds: retrySeconds,
            retryLock: true,
            retryAt: retryAt.toISOString(),
          },
        );
      }
      throw error;
    }
  }
  const result = await cancelActivationInternal(activation.id, "manual");
  return {
    activationId: activation.id,
    status: "cancelled",
    refundedUsd: result.refundedUsd ?? "0.00",
    balanceUsd: result.balanceUsd ?? null,
  };
}

/** 条件 UPDATE 抢占 + 回补，重复调用只会退款一次。 */
async function cancelActivationInternal(
  activationId: string,
  _source: "manual" | "upstream",
): Promise<{ refundedUsd: string; balanceUsd: string | null }> {
  const prisma = getPrisma();
  const ledger = getLedger();
  return prisma.$transaction(async (tx) => {
    const activation = await tx.activation.findUnique({ where: { id: activationId } });
    if (!activation) throw notFound("激活记录不存在");
    const claimed = await tx.activation.updateMany({
      where: { id: activationId, status: "waiting" },
      data: { status: "cancelled", closedAt: new Date() },
    });
    if (claimed.count === 0) {
      return { refundedUsd: "0.00", balanceUsd: null };
    }
    const refund = dec(String(activation.costUsd ?? activation.reservedUsd));
    if (refund.lte(0)) return { refundedUsd: "0.00", balanceUsd: null };
    const entry = await ledger.refundOnCancel(tx, activation.keyId, refund, activationId);
    return { refundedUsd: refund.toFixed(2), balanceUsd: entry.balanceAfter.toFixed(2) };
  });
}

/* ------------------------------------------------------------------ */
/* 查询兜底补单                                                        */
/* ------------------------------------------------------------------ */

export interface QueryOrderResultView {
  outTradeNo: string;
  status: string;
  faceUsd: string;
  amountLdc: string;
  code: string | null;
  codePrefix: string;
  /* true = 明文已过展示窗口，只剩哈希 */
  codeExpired: boolean;
  justIssued: boolean;
  warnings: string[];
}

/**
 * 卡密明文的「只展示一次」窗口：入账后 24 小时内可通过订单号取回，
 * 过期即从库里抹掉（只剩 SHA-256），之后再无人能取回。
 */
export const CODE_REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function extractStoredCode(raw: unknown): { code: string | null; codeAt: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { code: null, codeAt: null };
  const record = raw as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    codeAt: typeof record.codeAt === "string" ? record.codeAt : null,
  };
}

/** 过期后抹掉明文（尽力而为，失败不影响响应）。 */
async function wipeStoredCode(orderId: string, raw: unknown): Promise<void> {
  try {
    const record = raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
    delete record.code;
    record.codeWipedAt = new Date().toISOString();
    await getPrisma().order.update({
      where: { id: orderId },
      data: { rawNotify: record as Prisma.InputJsonValue },
    });
  } catch {
    // 忽略
  }
}

/** 主动查 LDC 兜底补单：本地 pending + 上游已成功 → 立即发卡密。 */
export async function queryAndSettleOrder(
  outTradeNo: string,
  options: { ldc?: LdcClient } = {},
): Promise<QueryOrderResultView> {
  const prisma = getPrisma();
  const order = await prisma.order.findUnique({ where: { outTradeNo } });
  if (!order) throw notFound("订单不存在");

  let justIssued = false;
  let warnings: string[] = [];
  let code: string | null = null;

  if (order.status === "pending") {
    const ldc = options.ldc ?? getLdcClient();
    const remote = await ldc.queryOrder(outTradeNo);
    if (remote.found && remote.paid) {
      const fulfilled = await fulfillPaidOrder({
        orderId: order.id,
        ldcTradeNo: remote.tradeNo,
        notify: { via: "query" },
        trace: "query",
      });
      justIssued = !fulfilled.alreadyPaid;
      code = fulfilled.code;
      warnings = fulfilled.warnings;
    }
  }

  const fresh = await prisma.order.findUnique({ where: { outTradeNo } });
  if (!fresh) throw notFound("订单不存在");

  let codePrefix = "";
  if (fresh.keyId) {
    const key = await prisma.cardKey.findUnique({ where: { id: fresh.keyId } });
    codePrefix = key ? key.codePrefix : "";
  }

  const stored = extractStoredCode(fresh.rawNotify);
  let codeExpired = false;
  if (!code && stored.code) {
    const issuedAt = stored.codeAt ? Date.parse(stored.codeAt) : Date.now();
    if (Number.isFinite(issuedAt) && Date.now() - issuedAt <= CODE_REVEAL_WINDOW_MS) {
      code = stored.code;
    } else {
      codeExpired = true;
      await wipeStoredCode(fresh.id, fresh.rawNotify);
    }
  }

  return {
    outTradeNo: fresh.outTradeNo,
    status: fresh.status,
    faceUsd: dec(fresh.faceUsd.toString()).toFixed(2),
    amountLdc: dec(fresh.amountLdc.toString()).toFixed(2),
    code,
    codePrefix,
    codeExpired,
    justIssued,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 保底回收：超时未收到验证码就取消激活，释放上游占用                    */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  scanned: number;
  /** 成功回收（上游已释放，本地置 expired，**不退还**卡密余额）。 */
  recycled: number;
  /** 期间收到验证码 → 按正常完成处理。 */
  completed: number;
  /** 上游仍拒绝取消（EARLY_CANCEL_DENIED 等），下次再试。 */
  deferred: number;
  errors: number;
  autoCancelMinutes: number;
}

let lastSweepAt = 0;
/**
 * 机会式巡检的最小间隔。
 *
 * 主路径是 pollActivation 里的按号龄判定（见上），这里只负责捞**被遗弃**的激活
 * ——买家关掉页面后没人轮询，就得靠这个 + /api/cron/sweep。
 * 20 秒限制只是避免同一实例每次请求都扫库。
 */
const SWEEP_MIN_INTERVAL_MS = 20_000;

/**
 * 弃单核账的「退款确认窗口」（分钟）。
 * 上游取号后处于可取消态的窗口实测 64s~334s 浮动；只有过了这个时间、且上游
 * 明确 CANCEL，才认定"这号不可能再出码"并退款，避免刚取号就误判退款。
 */
const DEFAULT_CONFIRM_CANCEL_MINUTES = 6;

/**
 * 取消失败后的重试锁兜底秒数（设置层读不到时用）。
 * 必须有兜底：settings.cancelRetrySeconds 缺失会让 Date 变 Invalid，
 * 抛 RangeError 把一次普通的"上游未解锁"变成 500。
 */
const DEFAULT_CANCEL_RETRY_SECONDS = 150;

/**
 * 充值前的池容量校验。
 *
 * 复用 pool.ts 的 assertPoolCapacity（不足时抛 PoolExhaustedError，
 * 路由层统一映射成 409 + 可读中文）。
 *
 * 用动态 import 而不是顶层 import：pool.ts 已经 import 了本文件的
 * getSiteSettings 等，顶层互相 import 会形成循环依赖。
 */
async function checkTopupPoolCapacity(amountUsd: DecimalInput): Promise<void> {
  const { assertPoolCapacity } = await import("./pool");
  await assertPoolCapacity(amountUsd);
}

/**
 * 机会式巡检：被轮询接口调用，同一实例最多每 60 秒真跑一次，失败静默。
 * 纯兜底，真正的频率保证靠 /api/cron/sweep 由外部定时器打。
 */
export async function maybeSweepStaleActivations(): Promise<SweepResult | null> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return null;
  lastSweepAt = now;
  try {
    return await sweepStaleActivations();
  } catch {
    return null;
  }
}

let lastReconcileAt = 0;
/** 弃单核账的机会式间隔：比 sweep 保守，因为它对每个 waiting 都要打一次上游。 */
const RECONCILE_MIN_INTERVAL_MS = 60_000;

/**
 * 机会式弃单核账：被轮询接口调用，同一实例最多每 60 秒真跑一次，失败静默。
 * 主路径仍是买家轮询；这里只负责捞**买家走开后就没人管**的那些。
 */
export async function maybeReconcileAbandoned(): Promise<Awaited<ReturnType<typeof reconcileAbandonedActivations>> | null> {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return null;
  lastReconcileAt = now;
  try {
    return await reconcileAbandonedActivations();
  } catch {
    return null;
  }
}

/**
 * 扫描「取号后超过 autoCancelMinutes 仍未收到验证码」的激活，取消掉以释放上游占用。
 *
 * 为什么要有：上游取消窗口实测在 64s～334s 之间浮动。号码一直挂着不但白占
 * 供应商库存，还可能拉低账号质量；实测 ACCESS_CANCEL 会把号码费用退回主账号。
 *
 * 计费口径（维护者定的规则）：**取消成功也不退还卡密余额** —— 号码已被消耗，
 * 买家承担未收到码的风险。因此这里只改状态、只释放上游，**不写任何 ledger**。
 *
 * 幂等：本地用条件 UPDATE 抢占（waiting → expired），重复跑不会重复处理。
 */
/**
 * 回收单个激活。定时器已废弃（serverless 内存定时器不可靠），
 * 现在由 pollActivation 的按号龄判定与 sweepStaleActivations 共用这一条逻辑，
 * 保证两条路径行为完全一致。
 *
 * 幂等：抢不到 waiting 就什么都不做。返回 deferred 表示上游此刻仍拒绝取消
 * （EARLY_CANCEL_DENIED 等），保持 waiting 等下次再试 —— 这是正确行为，不是失败。
 */
async function recycleOneActivation(activationId: string): Promise<"recycled" | "completed" | "deferred" | "skipped"> {
  const prisma = getPrisma();
  const activation = await prisma.activation.findUnique({ where: { id: activationId } });
  if (!activation || activation.status !== "waiting") return "skipped";

  const grizzly = getGrizzlyClient();
  let state: ParsedStatus;
  try {
    state = await grizzly.getStatus(activation.grizzlyId);
  } catch {
    return "deferred";
  }

  /* 期间收到码 → 按正常完成，绝不当成"没收到"回收掉 */
  if (state.state === "OK") {
    const claimed = await prisma.activation.updateMany({
      where: { id: activationId, status: "waiting" },
      data: { status: "ok", code: state.code, closedAt: new Date() },
    });
    if (claimed.count === 0) return "skipped";
    try {
      await grizzly.setStatus(activation.grizzlyId, GRIZZLY_STATUS.ACTIVATION);
    } catch {
      // 忽略
    }
    return "completed";
  }

  /*
   * 上游已取消 → **不在这里处理，交给 reconcileAbandonedActivations 退款**。
   *
   * 为什么跳过而不是像以前那样标 expired：上游取消意味着号不可能再出码，
   * 钱也已被上游退回主账号，此时应当把卡密余额退回买家（既定口径）。
   * 退款口径只保留在 reconciler 一处，避免两条路径给出不同结果。
   */
  if (state.state === "CANCEL") return "skipped";

  /* 主动取消，释放上游占用（上游退款给卖家，但不回补卡密余额） */
  try {
    await grizzly.setStatus(activation.grizzlyId, GRIZZLY_STATUS.CANCEL);
  } catch {
    return "deferred";
  }

  const claimed = await prisma.activation.updateMany({
    where: { id: activationId, status: "waiting" },
    data: { status: "expired", closedAt: new Date() },
  });
  return claimed.count > 0 ? "recycled" : "skipped";
}

/**
 * 核对「被遗弃」的激活：本地还挂着 waiting，但上游其实已经有结果了。
 *
 * 为什么必须有这个：本地激活状态**只靠买家浏览器轮询来更新**。买家一切走
 * —— 去开第二个号、点了取消但没等、或者直接关页面 —— 轮询就停了，本地记录
 * 永远冻在 waiting。而上游那边早就出了码、或者自己取消了（ACCESS_CANCEL
 * 把钱退回主账号）。这些钱就白白卡在激活记录里，谁也不知道。
 *
 * 实测（2026-10-11，实测发现）：wa/151 那笔 $0.12 卡了一整天，上游状态
 * STATUS_CANCEL、上游余额只少了成功那笔的 $0.15，但本地一直是 waiting。
 *
 * 与 sweepStaleActivations 的区别（**计费口径完全相反，别混**）：
 *   sweepStaleActivations          我们主动回收超时号 → 不退卡密余额
 *   reconcileAbandonedActivations  上游出的结果 → 出码就补记、上游取消就退款
 *
 * 触发方式：/api/cron/sweep（外部定时器，配 CONFIRM_CANCEL_MINUTES）+
 * 轮询接口机会式兜底。做成「按上游实际状态收口」而不是「按超时时间猜」，
 * 所以独立于 autoCancelMinutes 开关 —— 维护者可以关掉主动回收，但弃单核账
 * 属于资金安全，必须常开。
 *
 * 安全闸门：只有当「上游已经取消 且 取号后已超过 confirmCancelMinutes」时才退款。
 * 因为刚取号那几十秒里上游可能处于可取消态（实测取消窗口 64s~334s 浮动），
 * 一旦上游取消，这号就不可能再出码了 —— 此时退款把钱还给买家、同时把
 * ACCESS_CANCEL 从上游拿回的钱留给主账号。两边都不亏。
 *
 * 幂等：cancelActivationInternal 内部用条件 UPDATE（waiting → cancelled）抢占，
 * 重复跑不会重复退款。
 */
export async function reconcileAbandonedActivations(limit = 20): Promise<{
  scanned: number;
  completed: number;
  refunded: number;
  refundedUsd: string;
  skipped: number;
  errors: number;
}> {
  const prisma = getPrisma();
  const result = { scanned: 0, completed: 0, refunded: 0, refundedUsd: "0.00", skipped: 0, errors: 0 };

  /*
   * 按「上次检查时间」升序取，而不是按创建时间。
   *
   * 原来按 createdAt asc 取最老的 limit 条：只要最老那批一直解析不了
   * （上游持续返回 WAIT、或网络错误），每轮都重复扫它们，
   * 比它们新的弃单**永远轮不到** —— 资金永久卡住且无人发现。
   * 改成最久没被检查过的优先，天然公平轮转。
   */
  const waiting = await prisma.activation.findMany({
    where: { status: "waiting" },
    orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
  });
  if (!waiting.length) return result;
  result.scanned = waiting.length;

  const confirmMs = DEFAULT_CONFIRM_CANCEL_MINUTES * 60_000;

  const grizzly = getGrizzlyClient();
  let refundedTotal = dec(0);

  for (const activation of waiting) {
    /* 先打时间戳：无论这次成功与否，都算"检查过"，避免同一条被反复优先选中 */
    await prisma.activation
      .updateMany({ where: { id: activation.id, status: "waiting" }, data: { lastPolledAt: new Date() } })
      .catch(() => undefined);

    let state: ParsedStatus;
    try {
      state = await grizzly.getStatus(activation.grizzlyId);
    } catch (error) {
      /*
       * 上游说"没有这个激活"（NO_ACTIVATION）→ 号已经没了，永远不可能再出码。
       * 这种情况按已取消处理并退款；否则这一笔会永远卡在 waiting，
       * 每轮核账都抛错跳过，买家的钱再也没人管。
       *
       * 其它错误（网络抖动、上游 5xx）才计入 errors 留待下轮重试。
       */
      if (error instanceof GrizzlyApiError && error.code === "NO_ACTIVATION") {
        state = { state: "CANCEL" } as ParsedStatus;
      } else {
        result.errors += 1;
        continue;
      }
    }

    /* 上游其实已经出码了 → 补记，绝不让买家的码丢掉 */
    if (state.state === "OK") {
      const claimed = await prisma.activation.updateMany({
        where: { id: activation.id, status: "waiting" },
        data: { status: "ok", code: state.code, closedAt: new Date() },
      });
      if (claimed.count > 0) result.completed += 1;
      else result.skipped += 1;
      continue;
    }

    /* 上游已取消 → 过了安全窗口就把钱退回卡密（既定口径的口径） */
    if (state.state === "CANCEL") {
      const ageMs = Date.now() - activation.createdAt.getTime();
      if (ageMs < confirmMs) {
        result.skipped += 1;
        continue;
      }
      try {
        const r = await cancelActivationInternal(activation.id, "upstream");
        if (Number(r.refundedUsd) > 0) {
          refundedTotal = refundedTotal.plus(dec(r.refundedUsd));
          result.refunded += 1;
        } else {
          result.skipped += 1;
        }
      } catch {
        result.errors += 1;
      }
      continue;
    }

    /* 其余（WAIT_*、stale 等）留给主动回收逻辑，不在这里动 */
    result.skipped += 1;
  }

  result.refundedUsd = refundedTotal.toFixed(2);
  if (result.refunded || result.completed) {
    console.log("[reconcile-abandoned]", JSON.stringify(result));
  }
  return result;
}

/**
 * 审计：找出「扣了费但没退钱」的激活。
 *
 * 这是维护者要的"自动复核装置"的**只读那半边** —— 核账负责自动补退，
 * 这里负责把仍然对不上的挂到后台台面上，避免"没人看就永远没人管"。
 *
 * 判据：该激活关联的流水净额 < 0（钱出去了没回来）且激活没有成功出码。
 *   · status = cancelled/expired → 本该全额退回，净额应为 0
 *   · status = waiting 且已超过 graceMinutes → 监管缺失，应当已被核账收口
 *   · status = ok → 买家拿到码了，扣费天经地义，不算欠款
 *
 * 返回的是"需要人工看一眼"的清单，不自动改账（自动退款在核账里做）。
 */
export async function auditUnrefundedActivations(graceMinutes = 60): Promise<{
  graceMinutes: number;
  suspicious: Array<{
    activationId: string;
    keyPrefix: string;
    grizzlyId: string;
    service: string;
    country: string;
    phone: string;
    status: string;
    costUsd: string;
    netUsd: string;
    owedUsd: string;
    ageMinutes: number;
  }>;
  totalOwedUsd: string;
}> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);

  const acts = await prisma.activation.findMany({
    where: {
      status: { in: ["cancelled", "expired", "waiting"] },
      OR: [{ status: { in: ["cancelled", "expired"] } }, { createdAt: { lt: cutoff } }],
    },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { key: { select: { codePrefix: true } } },
  });

  const suspicious: Awaited<ReturnType<typeof auditUnrefundedActivations>>["suspicious"] = [];
  let totalOwed = dec(0);

  for (const a of acts) {
    const rows = await prisma.keyLedger.findMany({ where: { refId: a.id } });
    const net = rows.reduce((acc, r) => acc.plus(dec(r.deltaUsd.toString())), dec(0));
    /* 净额 >= 0 说明钱没亏在这个号上 */
    if (net.gte(0)) continue;
    suspicious.push({
      activationId: a.id,
      keyPrefix: a.key.codePrefix,
      grizzlyId: a.grizzlyId,
      service: a.service,
      country: a.country,
      phone: a.phone,
      status: a.status,
      costUsd: (a.costUsd ?? a.reservedUsd).toString(),
      netUsd: net.toFixed(4),
      owedUsd: net.negated().toFixed(4),
      ageMinutes: Math.floor((Date.now() - a.createdAt.getTime()) / 60_000),
    });
    totalOwed = totalOwed.plus(net.negated());
  }

  return { graceMinutes, suspicious, totalOwedUsd: totalOwed.toFixed(4) };
}

/**
 * 清掉已过 24 小时展示窗口的卡密明文。
 *
 * 为什么需要：发新卡时明文会临时写进 Order.rawNotify（供支付回跳页取回一次），
 * 但原来的清理是**惰性**的 —— 只有有人带着 outTradeNo 调 /api/pay/query
 * 且已超窗，才会把那一条抹掉。没人查过的订单，明文就一直躺在库里，
 * 与 README「卡密明文不落库，只存 SHA-256」的承诺不符；任何数据库快照
 * 都会带上可直接变现的明文。
 *
 * 这里做成定期物理清理（由 /api/cron/sweep 每次触发），保证超窗即抹，
 * 不依赖是否有人访问。
 */
export async function purgeExpiredCodes(limit = 200): Promise<{ scanned: number; wiped: number }> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - CODE_REVEAL_WINDOW_MS);

  /*
   * 只取「已付款、落在窗口外、且还没被抹过」的订单。
   * rawNotify 是 JSON，没法直接按字段查，所以按时间粗筛后在代码里精确判断。
   */
  const candidates = await prisma.order.findMany({
    where: { status: "paid", paidAt: { lt: cutoff } },
    orderBy: { paidAt: "asc" },
    take: limit,
  });

  let wiped = 0;
  for (const order of candidates) {
    const stored = extractStoredCode(order.rawNotify);
    if (!stored.code) continue; /* 没有明文（已抹或本来就没有） */
    const issuedAt = stored.codeAt ? Date.parse(stored.codeAt) : 0;
    /* 落款时间缺失也按已超窗处理：宁可早抹，不留明文 */
    if (Number.isFinite(issuedAt) && issuedAt > 0 && Date.now() - issuedAt <= CODE_REVEAL_WINDOW_MS) {
      continue;
    }
    await wipeStoredCode(order.id, order.rawNotify);
    wiped += 1;
  }

  if (wiped > 0) console.log("[purge-codes] 已清理明文", { scanned: candidates.length, wiped });
  return { scanned: candidates.length, wiped };
}

export async function sweepStaleActivations(limit = 20): Promise<SweepResult> {
  const prisma = getPrisma();
  const settings = await getSiteSettings();
  const minutes = settings.autoCancelMinutes;
  const empty: SweepResult = {
    scanned: 0,
    recycled: 0,
    completed: 0,
    deferred: 0,
    errors: 0,
    autoCancelMinutes: minutes,
  };
  if (!Number.isFinite(minutes) || minutes <= 0) return empty;

  const cutoff = new Date(Date.now() - minutes * 60_000);
  const stale = await prisma.activation.findMany({
    where: { status: "waiting", createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (!stale.length) return empty;

  const result: SweepResult = { ...empty, scanned: stale.length };

  /* 复用与闹钟相同的单条回收逻辑，保证两条路径行为完全一致 */
  for (const activation of stale) {
    let outcome: Awaited<ReturnType<typeof recycleOneActivation>>;
    try {
      outcome = await recycleOneActivation(activation.id);
    } catch {
      result.errors += 1;
      continue;
    }
    if (outcome === "recycled") result.recycled += 1;
    else if (outcome === "completed") result.completed += 1;
    else if (outcome === "deferred") result.deferred += 1;
  }
  if (result.recycled || result.completed) {
    console.log("[sweep] 保底回收", JSON.stringify(result));
  }
  return result;
}


