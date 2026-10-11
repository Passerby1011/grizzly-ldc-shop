/**
 * 池核算：`可用 = 真实余额 − 已售未消耗 − SAFETY_BUFFER_USD`。
 *
 * 同时负责「从池子里发卡密」这件事：
 * - `issueCardKeys`：管理端发卡（发之前必须校验可用池，不足 409）；
 * - `fulfillPaidOrder`：买家付款回调入账发卡（幂等，钱已收不阻塞发货，超卖只告警）。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { dec, toStorageString, type Decimal, type DecimalInput } from "./money";
import { getPrisma } from "./db";
import { getLedger } from "./ledger";
import { getGrizzlyClient, type GrizzlyClient } from "./grizzly";
import { codePrefix, generateCode, hashCode } from "./keycodec";
import { tryGetConfig } from "./config";
import { getSiteSettings } from "./settings";

export const DEFAULT_SAFETY_BUFFER_USD = "0.50";
export const MAX_KEYS_PER_BATCH = 50;
export const MIN_FACE_USD = "0.01";
export const MAX_FACE_USD = "1000";
/** 对账容差：小于此值视为「对得上」（真实余额与账本推算的取整误差）。 */
export const RECONCILE_TOLERANCE_USD = "0.01";
/** 发货后体检的等待预算（毫秒）。 */
export const POOL_CHECK_BUDGET_MS = 3000;

export class PoolExhaustedError extends Error {
  readonly requiredUsd: Decimal;
  readonly availableUsd: Decimal;
  readonly shortfallUsd: Decimal;

  constructor(requiredUsd: DecimalInput, availableUsd: DecimalInput) {
    const required = dec(requiredUsd);
    const available = dec(availableUsd);
    super(
      `可用池不足：需要 ${required.toFixed(2)} USD，可用 ${available.toFixed(2)} USD`,
    );
    this.name = "PoolExhaustedError";
    this.requiredUsd = required;
    this.availableUsd = available;
    this.shortfallUsd = required.minus(available);
  }
}

export type RealBalanceSource = "grizzly" | "snapshot" | "unknown";

export interface RealBalance {
  usd: Decimal;
  source: RealBalanceSource;
  observedAt: Date | null;
}

export interface PoolState {
  /* 真实余额（Grizzly 账户） */
  realBalanceUsd: Decimal;
  /* 已售未消耗（active 卡密余额之和） */
  allocatedUsd: Decimal;
  /* 安全缓冲 */
  safetyBufferUsd: Decimal;
  /* 可用实时池 = real − allocated − buffer（可能为负 = 超卖） */
  availableUsd: Decimal;
  source: RealBalanceSource;
  observedAt: Date | null;
  /* true = 真实余额取不到，用了快照或 0 兜底 */
  degraded: boolean;
}

/** 纯函数：池可用量。 */
export function computeAvailableUsd(
  realBalanceUsd: DecimalInput,
  allocatedUsd: DecimalInput,
  safetyBufferUsd: DecimalInput,
): Decimal {
  return dec(realBalanceUsd).minus(dec(allocatedUsd)).minus(dec(safetyBufferUsd));
}

/** 展示用：负数按 0 处理。 */
export function clampNonNegative(value: DecimalInput): Decimal {
  const amount = dec(value);
  return amount.isNegative() ? dec(0) : amount;
}

/**
 * 安全缓冲的**异步**解析：DB 设置 > 环境变量 > 默认。
 *
 * 曾经这里是同步函数，只读环境变量 —— 于是后台把「安全缓冲」从 0.50 改成 0.20
 * 之后，设置接口读回是 0.20（因为那是另一条读设置的路径），
 * 但池计算、概览、可用余额全都还在用 0.50。老板改了没生效。
 *
 * 现在统一走 getSiteSettings()，与汇率/锁定时长同一个来源。
 * 注意：设置层有 30 秒进程内缓存，改完最多 30 秒后生效。
 */
export async function resolveSafetyBufferUsd(override?: DecimalInput): Promise<Decimal> {
  if (override !== undefined) return dec(override);
  try {
    const settings = await getSiteSettings();
    return dec(settings.safetyBufferUsd);
  } catch {
    /* 设置层不可用（比如配置不全）时退回环境变量，保证池计算不挂 */
    const config = tryGetConfig();
    return dec(config?.SAFETY_BUFFER_USD ?? DEFAULT_SAFETY_BUFFER_USD);
  }
}

/** 已售未消耗：所有 active 卡密的余额之和。 */
export async function getAllocatedUsd(client = getPrisma()): Promise<Decimal> {
  const aggregate = await client.cardKey.aggregate({
    _sum: { balanceUsd: true },
    where: { status: "active" },
  });
  const value = aggregate._sum.balanceUsd;
  return value ? dec(value.toString()) : dec(0);
}

/** 历史总消耗：所有负向流水的绝对值之和。 */
export async function getConsumedUsd(client = getPrisma()): Promise<Decimal> {
  const aggregate = await client.keyLedger.aggregate({
    _sum: { deltaUsd: true },
    where: { deltaUsd: { lt: 0 } },
  });
  const value = aggregate._sum.deltaUsd;
  return value ? dec(value.toString()).negated() : dec(0);
}

/** 真实余额：优先实时查询 Grizzly，失败退回最近一次快照。 */
export async function getRealBalance(
  options: { client?: GrizzlyClient; prisma?: PrismaClient } = {},
): Promise<RealBalance> {
  const grizzly = options.client ?? getGrizzlyClient();
  const prisma = options.prisma ?? getPrisma();
  try {
    const usd = await grizzly.getBalance();
    return { usd, source: "grizzly", observedAt: new Date() };
  } catch {
    const snapshot = await prisma.grizzlySnapshot.findFirst({ orderBy: { createdAt: "desc" } });
    if (snapshot) {
      return {
        usd: dec(snapshot.realBalanceUsd.toString()),
        source: "snapshot",
        observedAt: snapshot.createdAt,
      };
    }
    return { usd: dec(0), source: "unknown", observedAt: null };
  }
}

export interface PoolStateOptions {
  client?: GrizzlyClient;
  prisma?: PrismaClient;
  safetyBufferUsd?: DecimalInput;
}

export async function getPoolState(options: PoolStateOptions = {}): Promise<PoolState> {
  const prisma = options.prisma ?? getPrisma();
  const [real, allocated] = await Promise.all([
    getRealBalance({ client: options.client, prisma }),
    getAllocatedUsd(prisma),
  ]);
  const buffer = await resolveSafetyBufferUsd(options.safetyBufferUsd);
  return {
    realBalanceUsd: real.usd,
    allocatedUsd: allocated,
    safetyBufferUsd: buffer,
    availableUsd: computeAvailableUsd(real.usd, allocated, buffer),
    source: real.source,
    observedAt: real.observedAt,
    degraded: real.source !== "grizzly",
  };
}

export interface CapacityCheck {
  ok: boolean;
  requiredUsd: Decimal;
  availableUsd: Decimal;
  shortfallUsd: Decimal;
  pool: PoolState;
}

/** 生成卡密前的可用池校验（不抛错版本）。 */
export async function checkPoolCapacity(
  requiredUsd: DecimalInput,
  options: PoolStateOptions = {},
): Promise<CapacityCheck> {
  const required = dec(requiredUsd);
  const pool = await getPoolState(options);
  const shortfall = required.minus(pool.availableUsd);
  return {
    ok: shortfall.lte(0),
    requiredUsd: required,
    availableUsd: pool.availableUsd,
    shortfallUsd: shortfall.isNegative() ? dec(0) : shortfall,
    pool,
  };
}

/** 不足时抛 PoolExhaustedError（路由映射成 409）。 */
export async function assertPoolCapacity(
  requiredUsd: DecimalInput,
  options: PoolStateOptions = {},
): Promise<PoolState> {
  const check = await checkPoolCapacity(requiredUsd, options);
  if (!check.ok) throw new PoolExhaustedError(check.requiredUsd, check.availableUsd);
  return check.pool;
}

export interface IssuedCardKey {
  id: string;
  code: string;
  codePrefix: string;
  faceUsd: string;
}

export interface IssueCardKeysResult {
  keys: IssuedCardKey[];
  totalFaceUsd: string;
  pool: PoolState;
}

export interface FulfillPaidOrderResult {
  /* true = 这笔订单之前已经入账过（重复回调） */
  alreadyPaid: boolean;
  keyId: string | null;
  /* 卡密明文：只在第一次入账时返回一次 */
  code: string | null;
  faceUsd: string;
  amountLdc: string;
  warnings: string[];
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return value as Prisma.InputJsonValue;
}

/**
 * 付款成功 → 发卡密。幂等靠「事务内条件更新 Order.status: pending → paid」，
 * 只有抢到这一次的请求才会建卡密；重复回调直接返回 `alreadyPaid: true`。
 * 钱已经收了，所以池子不足也照样发货，只在返回里带告警。
 */
export async function fulfillPaidOrder(input: {
  orderId: string;
  ldcTradeNo?: string | null;
  notify?: Record<string, unknown> | null;
  trace?: "notify" | "query";
}): Promise<FulfillPaidOrderResult> {
  const prisma = getPrisma();
  const ledger = getLedger();
  const { orderId } = input;

  const outcome = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`订单不存在: ${orderId}`);

    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: {
        status: "paid",
        paidAt: new Date(),
        ldcTradeNo: input.ldcTradeNo ?? undefined,
      },
    });

    /*
     * 幂等闸门：只有从 pending 成功改成 paid 的那一次才发货。
     *
     * 两种 kind 各自的「已发过」判据不同：
     *   purchase —— 看订单有没有绑卡（keyId 非空即已建过卡）
     *   topup    —— 看这张卡有没有收到过这笔订单的入账流水
     * 单看 claimed.count 不够：重复通知时它必然是 0，会直接落到 alreadyPaid。
     */
    if (claimed.count === 0) {
      return {
        alreadyPaid: true,
        keyId: order.keyId ?? order.targetKeyId,
        code: null as string | null,
        faceUsd: order.faceUsd.toString(),
        amountLdc: order.amountLdc.toString(),
      };
    }

    /* ---- 充值：给已有卡密加余额，不建新卡 ---- */
    if (order.kind === "topup") {
      if (!order.targetKeyId) {
        throw new Error(`充值订单缺少目标卡密: ${orderId}`);
      }
      const target = await tx.cardKey.findUnique({ where: { id: order.targetKeyId } });
      if (!target) throw new Error(`充值目标卡密不存在: ${order.targetKeyId}`);

      /*
       * 二次幂等：以「本订单是否已产生 topup 流水」为准。
       * 比只依赖 claimed.count 更稳 —— 即使订单状态被人工改回 pending 重发，
       * 也不会重复加钱。
       */
      const dup = await tx.keyLedger.findFirst({
        where: { refId: orderId, reason: "topup" },
        select: { id: true },
      });
      if (dup) {
        return {
          alreadyPaid: true,
          keyId: target.id,
          code: null as string | null,
          faceUsd: order.faceUsd.toString(),
          amountLdc: order.amountLdc.toString(),
        };
      }

      /* 加余额 —— getAllocatedUsd 是 sum(balanceUsd)，池占用会自动跟着涨 */
      await ledger.topUp(tx, target.id, order.faceUsd.toString(), orderId);

      /* 已作废/已耗尽的卡被充值后应回到可用状态 */
      if (target.status !== "active") {
        await tx.cardKey.update({ where: { id: target.id }, data: { status: "active" } });
        await tx.poolReservation.updateMany({
          where: { keyId: target.id },
          data: { released: false, releasedAt: null },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          rawNotify: toJsonInput({
            trace: input.trace ?? "notify",
            notify: input.notify ?? null,
            topup: true,
            targetPrefix: target.codePrefix,
            at: new Date().toISOString(),
          }),
        },
      });

      return {
        alreadyPaid: false,
        keyId: target.id,
        code: null as string | null,
        faceUsd: order.faceUsd.toString(),
        amountLdc: order.amountLdc.toString(),
      };
    }

    /* ---- 新购：原有逻辑，但补上 keyId 已存在的幂等判断 ---- */
    if (order.keyId) {
      return {
        alreadyPaid: true,
        keyId: order.keyId,
        code: null as string | null,
        faceUsd: order.faceUsd.toString(),
        amountLdc: order.amountLdc.toString(),
      };
    }

    const code = generateCode();
    const key = await tx.cardKey.create({
      data: {
        codeHash: hashCode(code),
        codePrefix: codePrefix(code),
        faceUsd: toStorageString(order.faceUsd),
        balanceUsd: toStorageString(0),
        status: "active",
        note: `order:${order.outTradeNo}`,
      },
    });
    await tx.poolReservation.create({
      data: { keyId: key.id, faceUsd: toStorageString(order.faceUsd) },
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        keyId: key.id,
        rawNotify: toJsonInput({
          trace: input.trace ?? "notify",
          notify: input.notify ?? null,
          code,
          codeAt: new Date().toISOString(),
        }),
      },
    });
    await ledger.allocate(tx, key.id, order.faceUsd.toString(), orderId);

    return {
      alreadyPaid: false,
      keyId: key.id,
      code,
      faceUsd: order.faceUsd.toString(),
      amountLdc: order.amountLdc.toString(),
    };
  });

  const warnings = outcome.alreadyPaid ? [] : await collectPoolWarnings();
  return { ...outcome, warnings };
}

/**
 * 发货后的超卖体检：钱已经收了不能因为池子不够就不发货，所以这里只收集告警。
 * 上游慢/挂掉时最多等 3 秒，绝不拖垮 LDC 通知的响应时间。
 */
async function collectPoolWarnings(): Promise<string[]> {
  const check = checkPoolCapacity(0)
    .then((result) =>
      result.availableUsd.lt(0) ? [`超卖告警：可用池已为 ${result.availableUsd.toFixed(2)} USD`] : [],
    )
    .catch(() => [] as string[]);
  const timeout = new Promise<string[]>((resolve) => {
    setTimeout(() => resolve([]), POOL_CHECK_BUDGET_MS);
  });
  return Promise.race([check, timeout]);
}

/** 账本推算余额 = 已售未消耗 + 历史总消耗。 */
export async function computeLedgerUsd(prisma: PrismaClient = getPrisma()): Promise<Decimal> {
  const [allocated, consumed] = await Promise.all([
    getAllocatedUsd(prisma),
    getConsumedUsd(prisma),
  ]);
  return allocated.plus(consumed);
}

export interface ReconcileResult {
  ok: boolean;
  /** 上游真实余额。 */
  realUsd: string;
  /** 本地推算的应有余额（= 基准 − 净消耗 − 手工调整）。字段名沿用 ledgerUsd 兼容旧调用。 */
  ledgerUsd: string;
  /** 差额 = 真实 − 应有。 */
  driftUsd: string;
  /** 对账基准（推断的上游初始投入）。 */
  baselineUsd: string;
  /** 净消耗：只含真正打到上游的部分。 */
  netConsumedUsd: string;
  /** 手工调整净额（不计入对账等式，单列展示）。 */
  manualAdjustedUsd: string;
  allocatedUsd: string;
  availableUsd: string;
  source: RealBalanceSource;
  message: string | null;
}

/**
 * 对账：真实余额 vs 账本推算，写快照 + 运行记录。
 * 有漂移（> 1 分钱）时 `ok=false` 并在 message 里说明，供 cron 告警。
 */
/**
 * 净消耗：**所有真正打到上游的余额变动**（只有这类才该进对账等式）。
 *
 * 与旧的 computeLedgerUsd 的关键区别：旧口径把「已售未消耗」当资产加进来，
 * 而作废/恢复卡密只改本地状态、不碰上游，却会改变「已售未消耗」——
 * 于是老板手动作废一张卡，对账就凭空差出一个卡片余额（实测差 1.74）。
 * 那是错误的等式，不是真的漂移。
 *
 * 进等式的只有：
 *   取号预扣(reserve/get_number)  −  退回(adjust_reserve/cancel_refund)
 * 出等式的（纯本地动作，不碰上游）：
 *   发卡/充值入账(reserve/topup)   —— 钱在卡里没花出去
 *   作废/恢复(改 status)           —— 连流水都不产生
 *   手工调整(manual)               —— 有正有负，方向不明，单独列出不计入
 */
export async function getNetConsumedUsd(client = getPrisma()): Promise<Decimal> {
  const aggregate = await client.keyLedger.aggregate({
    _sum: { deltaUsd: true },
    where: {
      reason: { in: ["get_number", "adjust_reserve", "cancel_refund"] },
    },
  });
  const value = aggregate._sum.deltaUsd;
  /* 取号是负向、退回是正向，求和后取负 = 净消耗 */
  return value ? dec(value.toString()).negated() : dec(0);
}

/** 手工调整的净额（正=给用户加钱，负=从用户扣钱）。不计入对账，但要在界面单列。 */
export async function getManualAdjustedUsd(client = getPrisma()): Promise<Decimal> {
  const aggregate = await client.keyLedger.aggregate({
    _sum: { deltaUsd: true },
    where: { reason: "manual" },
  });
  const value = aggregate._sum.deltaUsd;
  return value ? dec(value.toString()) : dec(0);
}

/** 读取对账基准；没有就按「当前余额 + 当前净消耗」推断一个并落库。 */
export async function ensureReconcileBaseline(
  realBalanceUsd: DecimalInput,
): Promise<{ baselineUsd: Decimal; created: boolean; tableMissing?: boolean }> {
  const prisma = getPrisma();
  let existing: { baselineUsd: { toString(): string } } | null = null;
  try {
    existing = await prisma.reconcileBaseline.findUnique({ where: { id: "singleton" } });
  } catch {
    /*
     * 表还没建（线上忘记跑 prisma db push）→ 降级为「按当前余额推算」，
     * 绝不让对账功能整个挂掉。此时差额必然为 0，界面会提示需要迁移。
     */
    const consumedFallback = await getNetConsumedUsd(prisma).catch(() => dec(0));
    return { baselineUsd: dec(realBalanceUsd).plus(consumedFallback), created: false, tableMissing: true };
  }
  if (existing) {
    return { baselineUsd: dec(existing.baselineUsd.toString()), created: false };
  }
  /*
   * 首次推断：假设此刻余额全部来自初始投入减去已发生的消耗，
   * 即 baseline = 当前余额 + 净消耗。这是**无漂移假设**下的自洽解，
   * 用于给老板一个起点，之后差额会诚实地显现出来。
   */
  const consumed = await getNetConsumedUsd(prisma);
  const baseline = dec(realBalanceUsd).plus(consumed);
  try {
    await prisma.reconcileBaseline.create({
      data: {
        id: "singleton",
        baselineUsd: toStorageString(baseline),
        consumedAtSetUsd: toStorageString(consumed),
        note: "首次自动推断",
      },
    });
    return { baselineUsd: baseline, created: true };
  } catch {
    /* 同上：表不存在时只推算不落库 */
    return { baselineUsd: baseline, created: false, tableMissing: true };
  }
}

/**
 * 对账：本地推算余额 vs 上游真实余额。
 *
 *   应有余额 = 基准投入 − 净消耗
 *   差额     = 真实余额 − 应有余额
 *
 * 差额只可能来自**我们不知道的上游变动**：老板手动给 Grizzly 充值、
 * 或直接在上游买了东西。作废/发卡/充值入账都不会造成差额。
 * 核对无误后点「校准」把差额并入基准即可归零。
 */
export async function runReconcile(
  options: { client?: GrizzlyClient; safetyBufferUsd?: DecimalInput } = {},
): Promise<ReconcileResult> {
  const prisma = getPrisma();
  const pool = await getPoolState(options);

  const netConsumed = await getNetConsumedUsd(prisma);
  const manualAdjusted = await getManualAdjustedUsd(prisma);
  const { baselineUsd } = await ensureReconcileBaseline(pool.realBalanceUsd);

  /* 手工调整不改变上游，但它确实动了卡密余额，所以从应有余额里扣掉，
     避免老板手动加过钱之后被误判成漂移 */
  const expectedUsd = baselineUsd.minus(netConsumed).minus(manualAdjusted);
  const drift = pool.realBalanceUsd.minus(expectedUsd);
  const ok = drift.abs().lte(dec(RECONCILE_TOLERANCE_USD));
  const message = ok
    ? null
    : `合计差 ${drift.toFixed(4)} USD（真实 ${pool.realBalanceUsd.toFixed(2)} / 应有 ${expectedUsd.toFixed(2)}）`;

  const ledgerUsd = expectedUsd;

  const activeCount = await prisma.activation.count({ where: { status: "waiting" } });
  await prisma.grizzlySnapshot.create({
    data: {
      realBalanceUsd: toStorageString(pool.realBalanceUsd),
      allocatedUsd: toStorageString(pool.allocatedUsd),
      availableUsd: toStorageString(pool.availableUsd),
      activeCount,
    },
  });
  await prisma.reconcileRun.create({
    data: {
      ok,
      ledgerUsd: toStorageString(ledgerUsd),
      realUsd: toStorageString(pool.realBalanceUsd),
      driftUsd: toStorageString(drift),
      message,
    },
  });

  return {
    ok,
    realUsd: pool.realBalanceUsd.toFixed(2),
    ledgerUsd: expectedUsd.toFixed(2),
    driftUsd: drift.toFixed(4),
    baselineUsd: baselineUsd.toFixed(2),
    netConsumedUsd: netConsumed.toFixed(2),
    manualAdjustedUsd: manualAdjusted.toFixed(2),
    allocatedUsd: pool.allocatedUsd.toFixed(2),
    availableUsd: pool.availableUsd.toFixed(2),
    source: pool.source,
    message,
  };
}

/**
 * 校准：把当前差额并入基准，使对账归零。
 *
 * 用途：老板手动给 Grizzly 充过值 / 在上游买过东西后，差额是**真实且合理**的，
 * 记下来即可。校准不修改任何卡密余额与流水，只调整基准这一个数。
 */
export async function calibrateBaseline(): Promise<{ baselineUsd: string; driftBefore: string }> {
  const prisma = getPrisma();
  const pool = await getPoolState();
  const netConsumed = await getNetConsumedUsd(prisma);
  const manualAdjusted = await getManualAdjustedUsd(prisma);
  const { baselineUsd } = await ensureReconcileBaseline(pool.realBalanceUsd);

  const expected = baselineUsd.minus(netConsumed).minus(manualAdjusted);
  const drift = pool.realBalanceUsd.minus(expected);
  /* 新基准 = 真实余额 + 净消耗 + 手工调整（即让 expected 恰好等于真实） */
  const next = pool.realBalanceUsd.plus(netConsumed).plus(manualAdjusted);

  await prisma.reconcileBaseline.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      baselineUsd: toStorageString(next),
      consumedAtSetUsd: toStorageString(netConsumed),
      note: `校准（原差额 ${drift.toFixed(4)}）`,
    },
    update: {
      baselineUsd: toStorageString(next),
      consumedAtSetUsd: toStorageString(netConsumed),
      note: `校准（原差额 ${drift.toFixed(4)}）`,
    },
  });

  return { baselineUsd: next.toFixed(2), driftBefore: drift.toFixed(4) };
}

export interface IssueCardKeysInput {
  faceUsd: DecimalInput;
  count: number;
  note?: string | null;
  refId?: string | null;
  enforcePool?: boolean;
  safetyBufferUsd?: DecimalInput;
}

/**
 * 管理端发卡：先校验可用池，再在**一个事务**里建卡密（余额 0）→ 池预留 → 账本入账。
 * 卡密明文只在此处返回一次，库里只存 SHA-256。
 */
export async function issueCardKeys(input: IssueCardKeysInput): Promise<IssueCardKeysResult> {
  const faceUsd = dec(input.faceUsd);
  if (faceUsd.lt(MIN_FACE_USD)) throw new RangeError(`面值至少要 ${MIN_FACE_USD} USD`);
  if (faceUsd.gt(MAX_FACE_USD)) throw new RangeError(`面值不能超过 ${MAX_FACE_USD} USD`);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_KEYS_PER_BATCH) {
    throw new RangeError(`单批数量必须在 1..${MAX_KEYS_PER_BATCH} 之间`);
  }

  const totalFaceUsd = faceUsd.times(input.count);
  const pool =
    input.enforcePool === false
      ? await getPoolState({ safetyBufferUsd: input.safetyBufferUsd })
      : await assertPoolCapacity(totalFaceUsd, { safetyBufferUsd: input.safetyBufferUsd });

  const drafts = Array.from({ length: input.count }, () => {
    const code = generateCode();
    return { code, hash: hashCode(code), prefix: codePrefix(code) };
  });

  const prisma = getPrisma();
  const ledger = getLedger();
  const created: IssuedCardKey[] = [];

  await prisma.$transaction(async (tx) => {
    for (const draft of drafts) {
      const key = await tx.cardKey.create({
        data: {
          codeHash: draft.hash,
          codePrefix: draft.prefix,
          faceUsd: toStorageString(faceUsd),
          balanceUsd: toStorageString(0),
          status: "active",
          note: input.note ?? null,
          expiresAt: null,
        },
      });
      await tx.poolReservation.create({
        data: { keyId: key.id, faceUsd: toStorageString(faceUsd) },
      });
      await ledger.allocate(tx, key.id, faceUsd, input.refId ?? key.id);
      created.push({ id: key.id, code: draft.code, codePrefix: draft.prefix, faceUsd: faceUsd.toFixed(2) });
    }
  });

  return {
    keys: created,
    totalFaceUsd: totalFaceUsd.toFixed(2),
    pool,
  };
}
