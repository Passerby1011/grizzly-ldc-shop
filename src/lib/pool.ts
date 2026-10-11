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

export function resolveSafetyBufferUsd(override?: DecimalInput): Decimal {
  if (override !== undefined) return dec(override);
  const config = tryGetConfig();
  return dec(config?.SAFETY_BUFFER_USD ?? DEFAULT_SAFETY_BUFFER_USD);
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
  const buffer = resolveSafetyBufferUsd(options.safetyBufferUsd);
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
  realUsd: string;
  ledgerUsd: string;
  driftUsd: string;
  allocatedUsd: string;
  availableUsd: string;
  source: RealBalanceSource;
  message: string | null;
}

/**
 * 对账：真实余额 vs 账本推算，写快照 + 运行记录。
 * 有漂移（> 1 分钱）时 `ok=false` 并在 message 里说明，供 cron 告警。
 */
export async function runReconcile(
  options: { client?: GrizzlyClient; safetyBufferUsd?: DecimalInput } = {},
): Promise<ReconcileResult> {
  const prisma = getPrisma();
  const pool = await getPoolState(options);
  const ledgerUsd = await computeLedgerUsd(prisma);
  const drift = pool.realBalanceUsd.minus(ledgerUsd);
  const ok = drift.abs().lte(dec(RECONCILE_TOLERANCE_USD));
  const message = ok
    ? null
    : `账本漂移 ${drift.toFixed(4)} USD（真实 ${pool.realBalanceUsd.toFixed(2)} / 账本 ${ledgerUsd.toFixed(2)}）`;

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
    ledgerUsd: ledgerUsd.toFixed(2),
    driftUsd: drift.toFixed(4),
    allocatedUsd: pool.allocatedUsd.toFixed(2),
    availableUsd: pool.availableUsd.toFixed(2),
    source: pool.source,
    message,
  };
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
