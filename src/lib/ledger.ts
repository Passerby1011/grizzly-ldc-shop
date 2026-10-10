/**
 * 账本 —— 本站的会计核心。
 *
 * 铁律：
 * 1. **禁止先读后写**。余额变动只能走原子条件 UPDATE：
 *      UPDATE "CardKey" SET "balanceUsd" = "balanceUsd" - $1
 *       WHERE id = $2 AND status = 'active' AND "balanceUsd" >= $1
 *      RETURNING "balanceUsd"
 *    返回 0 行即余额不足，直接拒绝。
 * 2. 每笔余额变动**必写一条 `KeyLedger`**，含 `balanceAfter`；两者在同一事务里。
 * 3. 取号先按上限预扣，成功后退回差额，失败全额退回；取消在 setStatus(8) 成功后才回补。
 *
 * 业务层只依赖 `LedgerStore` 抽象，测试用内存假实现验证语义。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { dec, toStorageString, type Decimal, type DecimalInput } from "./money";
import { getPrisma } from "./db";

export type LedgerReason =
  | "reserve"
  | "get_number"
  | "adjust_reserve"
  | "cancel_refund"
  | "manual"
  | "expire";

export const LEDGER_REASONS: readonly LedgerReason[] = [
  "reserve",
  "get_number",
  "adjust_reserve",
  "cancel_refund",
  "manual",
  "expire",
];

/** 可以是 PrismaClient，也可以是 `$transaction` 回调里的事务客户端。 */
export type LedgerDb = PrismaClient | Prisma.TransactionClient;

export interface LedgerEntry {
  keyId: string;
  /** 负数=扣费，正数=回补。 */
  deltaUsd: Decimal;
  balanceAfter: Decimal;
  reason: LedgerReason;
  refId: string | null;
}

export interface LedgerStore {
  /** 原子条件扣款 + 写流水（同一事务）。余额不足或卡密不可用返回 null。 */
  debit(
    db: LedgerDb | undefined,
    keyId: string,
    amountUsd: Decimal,
    reason: LedgerReason,
    refId: string | null,
  ): Promise<LedgerEntry | null>;
  /** 原子入账 + 写流水（同一事务）。卡密不存在返回 null。 */
  credit(
    db: LedgerDb | undefined,
    keyId: string,
    amountUsd: Decimal,
    reason: LedgerReason,
    refId: string | null,
  ): Promise<LedgerEntry | null>;
  /** 余额只读查询（展示用，绝不用于记账决策）。 */
  balance(keyId: string): Promise<Decimal | null>;
}

export class InsufficientBalanceError extends Error {
  readonly keyId: string;
  readonly amountUsd: Decimal;

  constructor(keyId: string, amountUsd: DecimalInput) {
    super(`卡密余额不足（需要 ${dec(amountUsd).toFixed(2)} USD）`);
    this.name = "InsufficientBalanceError";
    this.keyId = keyId;
    this.amountUsd = dec(amountUsd);
  }
}

export class KeyNotFoundError extends Error {
  readonly keyId: string;

  constructor(keyId: string) {
    super(`卡密不存在或已不可用: ${keyId}`);
    this.name = "KeyNotFoundError";
    this.keyId = keyId;
  }
}

export interface SettleResult {
  reservedUsd: Decimal;
  actualUsd: Decimal;
  refundedUsd: Decimal;
  balanceAfter: Decimal;
}

/**
 * 账本门面。所有方法都只通过 `LedgerStore` 的原子原语改余额，
 * 自身不做「读余额 → 判断 → 写余额」。
 */
export class Ledger {
  constructor(private readonly store: LedgerStore) {}

  /** 只读余额（展示用）。 */
  async balance(keyId: string): Promise<Decimal | null> {
    return this.store.balance(keyId);
  }

  /** 通用扣款：余额不足直接拒绝。 */
  async debitOrThrow(
    db: LedgerDb | undefined,
    keyId: string,
    amountUsd: DecimalInput,
    reason: LedgerReason,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    const amount = dec(amountUsd);
    if (amount.lte(0)) throw new RangeError("扣款金额必须大于 0");
    const entry = await this.store.debit(db, keyId, amount, reason, refId);
    if (!entry) throw new InsufficientBalanceError(keyId, amount);
    return entry;
  }

  /** 通用入账（回补）。 */
  async creditOrThrow(
    db: LedgerDb | undefined,
    keyId: string,
    amountUsd: DecimalInput,
    reason: LedgerReason,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    const amount = dec(amountUsd);
    if (amount.lte(0)) throw new RangeError("入账金额必须大于 0");
    const entry = await this.store.credit(db, keyId, amount, reason, refId);
    if (!entry) throw new KeyNotFoundError(keyId);
    return entry;
  }

  /** 发卡密：把面值写进卡密余额（0 → faceUsd）。 */
  async allocate(
    db: LedgerDb | undefined,
    keyId: string,
    faceUsd: DecimalInput,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    return this.creditOrThrow(db, keyId, faceUsd, "reserve", refId);
  }

  /** 取号上限预扣。 */
  async reserveForNumber(
    db: LedgerDb | undefined,
    keyId: string,
    capUsd: DecimalInput,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    return this.debitOrThrow(db, keyId, capUsd, "get_number", refId);
  }

  /**
   * 取号成功后的差额退回：把预扣的上限收敛到真实成本。
   * 真实成本 >= 上限时不退（不可能多退）。
   */
  async settleReservation(
    db: LedgerDb | undefined,
    keyId: string,
    reservedUsd: DecimalInput,
    actualUsd: DecimalInput,
    refId: string | null = null,
  ): Promise<SettleResult> {
    const reserved = dec(reservedUsd);
    const actual = dec(actualUsd);
    const diff = reserved.minus(actual);
    if (diff.lte(0)) {
      const current = await this.store.balance(keyId);
      return {
        reservedUsd: reserved,
        actualUsd: actual,
        refundedUsd: dec(0),
        balanceAfter: current ?? dec(0),
      };
    }
    const entry = await this.creditOrThrow(db, keyId, diff, "adjust_reserve", refId);
    return {
      reservedUsd: reserved,
      actualUsd: actual,
      refundedUsd: diff,
      balanceAfter: entry.balanceAfter,
    };
  }

  /** 取消回补（只在 setStatus(8) 成功之后调用）。 */
  async refundOnCancel(
    db: LedgerDb | undefined,
    keyId: string,
    amountUsd: DecimalInput,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    return this.creditOrThrow(db, keyId, amountUsd, "cancel_refund", refId);
  }

  /** 管理端手工调整（delta 可为负）。 */
  async manualAdjust(
    db: LedgerDb | undefined,
    keyId: string,
    deltaUsd: DecimalInput,
    refId: string | null = null,
  ): Promise<LedgerEntry> {
    const delta = dec(deltaUsd);
    if (delta.isZero()) throw new RangeError("调整金额不能为 0");
    if (delta.isNegative()) return this.debitOrThrow(db, keyId, delta.negated(), "manual", refId);
    return this.creditOrThrow(db, keyId, delta, "manual", refId);
  }
}

/**
 * 只有「我们自己拥有连接」时才开事务；调用方传进来的 db（PrismaClient 或事务客户端）
 * 一律直接使用，避免嵌套事务导致死锁。
 */
async function runInTransaction<T>(
  db: LedgerDb | undefined,
  fn: (tx: LedgerDb) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return getPrisma().$transaction((tx) => fn(tx));
}

interface RawBalanceRow {
  balanceUsd: Prisma.Decimal;
}

/**
 * Prisma 实现。余额一律用条件 UPDATE 改，绝不先读后写。
 * 参数以字符串 + `::numeric` 传入，避免二进制浮点误差与类型推断问题。
 */
export function createPrismaLedgerStore(client?: () => PrismaClient): LedgerStore {
  const resolve = client ?? getPrisma;

  async function apply(
    db: LedgerDb | undefined,
    keyId: string,
    amount: Decimal,
    direction: "debit" | "credit",
    reason: LedgerReason,
    refId: string | null,
  ): Promise<LedgerEntry | null> {
    const isDebit = direction === "debit";
    const amountSql = toStorageString(amount);
    const delta = isDebit ? amount.negated() : amount;
    return runInTransaction(db, async (tx) => {
      const rows = isDebit
        ? await tx.$queryRaw<RawBalanceRow[]>`
            UPDATE "CardKey"
               SET "balanceUsd" = "balanceUsd" - ${amountSql}::numeric
             WHERE id = ${keyId}
               AND status = 'active'
               AND "balanceUsd" >= ${amountSql}::numeric
            RETURNING "balanceUsd"
          `
        : await tx.$queryRaw<RawBalanceRow[]>`
            UPDATE "CardKey"
               SET "balanceUsd" = "balanceUsd" + ${amountSql}::numeric
             WHERE id = ${keyId}
            RETURNING "balanceUsd"
          `;
      if (rows.length === 0) return null;
      /* 走字符串边界：不假设驱动返回的 Decimal 与 Prisma.Decimal 是同一个类实例 */
      const balanceAfter = dec(String(rows[0].balanceUsd));
      await tx.keyLedger.create({
        data: {
          keyId,
          deltaUsd: toStorageString(delta),
          balanceAfter: toStorageString(balanceAfter),
          reason,
          refId,
        },
      });
      if (balanceAfter.isZero() && isDebit) {
        await tx.cardKey.updateMany({
          where: { id: keyId, balanceUsd: 0, status: "active" },
          data: { status: "depleted" },
        });
      } else if (balanceAfter.gt(0)) {
        await tx.cardKey.updateMany({
          where: { id: keyId, status: "depleted" },
          data: { status: "active" },
        });
      }
      return { keyId, deltaUsd: delta, balanceAfter, reason, refId };
    });
  }

  return {
    debit(db, keyId, amountUsd, reason, refId = null) {
      return apply(db, keyId, amountUsd, "debit", reason, refId);
    },
    credit(db, keyId, amountUsd, reason, refId = null) {
      return apply(db, keyId, amountUsd, "credit", reason, refId);
    },
    async balance(keyId) {
      const row = await resolve().cardKey.findUnique({
        where: { id: keyId },
        select: { balanceUsd: true },
      });
      return row ? dec(row.balanceUsd.toString()) : null;
    },
  };
}

let cachedLedger: Ledger | null = null;

export function getLedger(): Ledger {
  if (!cachedLedger) cachedLedger = new Ledger(createPrismaLedgerStore());
  return cachedLedger;
}
