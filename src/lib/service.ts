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
export function isKeyUsable(key: { status: string; expiresAt: Date | null }): boolean {
  if (key.status !== "active") return false;
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
  if (!isKeyUsable(key)) throw forbidden("卡密不可用（已过期或已失效）");

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

  /* 回填价格缓存（真实成交成本） */
  try {
    await getPriceProvider().observe(input.service, input.country, cost);
  } catch {
    // 缓存回填失败不影响取号
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

  if (activation.status === "ok") {
    return toPollResult(activation, null);
  }
  if (activation.status === "cancelled" || activation.status === "expired") {
    return toPollResult(activation, null);
  }

  const parsed: ParsedStatus = await grizzly.getStatus(activation.grizzlyId);
  await prisma.activation.update({
    where: { id: activation.id },
    data: { lastPolledAt: new Date() },
  });

  switch (parsed.state) {
    case "OK": {
      /* 完成：落库 + setStatus(6) 正式扣费（失败不回滚，钱已收） */
      try {
        await grizzly.setStatus(activation.grizzlyId, GRIZZLY_STATUS.ACTIVATION);
      } catch {
        // 忽略：状态已经是 OK
      }
      const smsText = await fetchSmsText(grizzly, activation.grizzlyId);
      const updated = await prisma.activation.update({
        where: { id: activation.id },
        data: { status: "ok", code: parsed.code, smsText, closedAt: new Date() },
      });
      return toPollResult(updated, null);
    }
    case "CANCEL": {
      /* 上游取消 → 等价于取消回补 */
      const refund = await cancelActivationInternal(activation.id, "upstream");
      const latest = await prisma.activation.findUnique({ where: { id: activation.id } });
      return { ...toPollResult(latest ?? activation, "上游已取消，余额已回补"), balanceUsd: refund.balanceUsd };
    }
    case "WAIT_RETRY":
      return toPollResult(activation, "等待重发验证码");
    case "WAIT_RESEND":
      return toPollResult(activation, "已请求重发");
    case "WAIT_CODE":
      return toPollResult(activation, null);
    default:
      return toPollResult(activation, "上游返回未知状态");
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
  activation: { id: string; status: string; code: string | null; smsText: string | null; phone: string; costUsd: unknown; reservedUsd: unknown; createdAt: Date },
  hint: string | null,
): PollActivationResult {
  const cost = activation.costUsd ?? activation.reservedUsd;
  const window = cancelWindow(activation.createdAt);
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
  };
}

/**
 * 取消锁：取号后 CANCEL_LOCK_SECONDS 内不可取消（实测约 60s 会被上游拒绝）。
 * 由 `Activation.createdAt + CANCEL_LOCK_SECONDS` 服务端计算，刷新页面也不会丢。
 */
function cancelWindow(createdAt: Date): { cancelAvailableInSeconds: number; cancelLockedUntil: string } {
  const lockUntilMs = createdAt.getTime() + getConfig().CANCEL_LOCK_SECONDS * 1000;
  return {
    cancelAvailableInSeconds: Math.max(0, Math.ceil((lockUntilMs - Date.now()) / 1000)),
    cancelLockedUntil: new Date(lockUntilMs).toISOString(),
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

  /* 本地闸门：取号后 CANCEL_LOCK_SECONDS 内直接拒绝，不打扰上游。 */
  const lockSeconds = getConfig().CANCEL_LOCK_SECONDS;
  const lockUntil = activation.createdAt.getTime() + lockSeconds * 1000;
  if (Date.now() < lockUntil) {
    throw conflict(ERROR_CODES.CONFLICT, `取号后需等待 ${lockSeconds} 秒才能取消`, {
      retryAfterSeconds: Math.ceil((lockUntil - Date.now()) / 1000),
    });
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
      /* 上游仍拒绝过早取消（如其它服务阈值更高）→ 409 + 可读中文，绝不冒泡成 UNKNOWN */
      if (error instanceof GrizzlyApiError && error.code === "EARLY_CANCEL_DENIED") {
        throw conflict(ERROR_CODES.CONFLICT, "上游暂不允许取消，请稍后再试", {
          retryAfterSeconds: 15,
        });
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
