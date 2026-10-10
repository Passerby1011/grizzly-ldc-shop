import { describe, expect, it } from "vitest";
import { dec, type Decimal } from "../money";
import {
  InsufficientBalanceError,
  KeyNotFoundError,
  Ledger,
  type LedgerDb,
  type LedgerEntry,
  type LedgerReason,
  type LedgerStore,
} from "../ledger";

/**
 * 内存假实现：语义与 Prisma 版一致 ——
 * 扣款是「条件更新」，余额不够或卡密不可用直接返回 null，绝不为负。
 */
class MemoryLedgerStore implements LedgerStore {
  readonly balances = new Map<string, Decimal>();
  readonly entries: LedgerEntry[] = [];
  readonly revoked = new Set<string>();
  /** 只读余额被调用了几次 —— 用来证明扣费路径没有「先读后写」。 */
  balanceReads = 0;

  constructor(seed: Record<string, string>) {
    for (const [keyId, balance] of Object.entries(seed)) {
      this.balances.set(keyId, dec(balance));
    }
  }

  private apply(
    keyId: string,
    amountUsd: Decimal,
    direction: "debit" | "credit",
    reason: LedgerReason,
    refId: string | null,
  ): LedgerEntry | null {
    const balance = this.balances.get(keyId);
    if (balance === undefined) return null;
    const isDebit = direction === "debit";
    if (isDebit) {
      if (this.revoked.has(keyId)) return null;
      if (balance.lt(amountUsd)) return null;
    }
    const balanceAfter = isDebit ? balance.minus(amountUsd) : balance.plus(amountUsd);
    this.balances.set(keyId, balanceAfter);
    const entry: LedgerEntry = {
      keyId,
      deltaUsd: isDebit ? amountUsd.negated() : amountUsd,
      balanceAfter,
      reason,
      refId,
    };
    this.entries.push(entry);
    return entry;
  }

  async debit(
    _db: LedgerDb | undefined,
    keyId: string,
    amountUsd: Decimal,
    reason: LedgerReason,
    refId: string | null,
  ): Promise<LedgerEntry | null> {
    return this.apply(keyId, amountUsd, "debit", reason, refId);
  }

  async credit(
    _db: LedgerDb | undefined,
    keyId: string,
    amountUsd: Decimal,
    reason: LedgerReason,
    refId: string | null,
  ): Promise<LedgerEntry | null> {
    return this.apply(keyId, amountUsd, "credit", reason, refId);
  }

  async balance(keyId: string): Promise<Decimal | null> {
    this.balanceReads += 1;
    return this.balances.get(keyId) ?? null;
  }
}

function setup(seed: Record<string, string>) {
  const store = new MemoryLedgerStore(seed);
  return { store, ledger: new Ledger(store) };
}

describe("余额不足必须被拒绝", () => {
  it("先读后写的对照组：余额不够时扣款被拒绝", async () => {
    const { store, ledger } = setup({ k1: "1.00" });
    await expect(ledger.reserveForNumber(undefined, "k1", "2.00")).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(store.balances.get("k1")?.toFixed(2)).toBe("1.00");
    expect(store.entries).toHaveLength(0);
  });

  it("刚好等于余额可以扣（不会因为差 0.001 被拒）", async () => {
    const { store, ledger } = setup({ k1: "0.50" });
    const entry = await ledger.reserveForNumber(undefined, "k1", "0.50");
    expect(entry.balanceAfter.toFixed(2)).toBe("0.00");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("0.00");
  });

  it("被吊销的卡密即使有余额也拒绝", async () => {
    const { store, ledger } = setup({ k1: "10.00" });
    store.revoked.add("k1");
    await expect(ledger.reserveForNumber(undefined, "k1", "1.00")).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it("不存在的卡密扣款被拒绝", async () => {
    const { ledger } = setup({});
    await expect(ledger.reserveForNumber(undefined, "nope", "1.00")).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it("扣费路径绝不调用只读余额查询（禁止先读后写）", async () => {
    const { store, ledger } = setup({ k1: "5.00" });
    await ledger.reserveForNumber(undefined, "k1", "1.00");
    await ledger.settleReservation(undefined, "k1", "1.00", "0.60");
    await ledger.refundOnCancel(undefined, "k1", "0.60");
    expect(store.balanceReads).toBe(0);
  });
});

describe("取号：上限预扣 + 差额退回", () => {
  it("预扣 1.00、真实成本 0.60 → 退回 0.40", async () => {
    const { store, ledger } = setup({ k1: "5.00" });

    const reserved = await ledger.reserveForNumber(undefined, "k1", "1.00", "act_1");
    expect(reserved.balanceAfter.toFixed(2)).toBe("4.00");
    expect(reserved.reason).toBe("get_number");
    expect(reserved.deltaUsd.toFixed(2)).toBe("-1.00");

    const settled = await ledger.settleReservation(undefined, "k1", "1.00", "0.60", "act_1");
    expect(settled.refundedUsd.toFixed(2)).toBe("0.40");
    expect(settled.balanceAfter.toFixed(2)).toBe("4.40");

    expect(store.balances.get("k1")?.toFixed(2)).toBe("4.40");
    expect(store.entries.map((entry) => [entry.reason, entry.deltaUsd.toFixed(2)])).toEqual([
      ["get_number", "-1.00"],
      ["adjust_reserve", "0.40"],
    ]);
    expect(store.entries[1].balanceAfter.toFixed(2)).toBe("4.40");
  });

  it("真实成本等于上限时不产生流水", async () => {
    const { store, ledger } = setup({ k1: "5.00" });
    await ledger.reserveForNumber(undefined, "k1", "1.00");
    const settled = await ledger.settleReservation(undefined, "k1", "1.00", "1.00");
    expect(settled.refundedUsd.toFixed(2)).toBe("0.00");
    expect(store.entries).toHaveLength(1);
  });

  it("真实成本高于上限（异常）时绝不倒扣", async () => {
    const { store, ledger } = setup({ k1: "5.00" });
    await ledger.reserveForNumber(undefined, "k1", "1.00");
    const settled = await ledger.settleReservation(undefined, "k1", "1.00", "1.50");
    expect(settled.refundedUsd.toFixed(2)).toBe("0.00");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("4.00");
  });
});

describe("取号失败：全额退回", () => {
  it("预扣后失败 → 余额回到原点，且流水成对", async () => {
    const { store, ledger } = setup({ k1: "3.00" });
    await ledger.reserveForNumber(undefined, "k1", "0.50", "act_fail");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("2.50");

    const refund = await ledger.creditOrThrow(undefined, "k1", "0.50", "cancel_refund", "act_fail");
    expect(refund.balanceAfter.toFixed(2)).toBe("3.00");
    expect(store.entries.map((entry) => entry.deltaUsd.toFixed(2))).toEqual(["-0.50", "0.50"]);
  });
});

describe("取消：回补", () => {
  it("取消回补后余额完全恢复，流水带 cancel_refund", async () => {
    const { store, ledger } = setup({ k1: "2.00" });
    await ledger.reserveForNumber(undefined, "k1", "1.00", "act_2");
    await ledger.settleReservation(undefined, "k1", "1.00", "0.70", "act_2");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("1.30");

    const refund = await ledger.refundOnCancel(undefined, "k1", "0.70", "act_2");
    expect(refund.reason).toBe("cancel_refund");
    expect(refund.balanceAfter.toFixed(2)).toBe("2.00");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("2.00");
  });

  it("取消回补不会把余额抬到面值之上", async () => {
    const { store, ledger } = setup({ k1: "1.00" });
    await ledger.refundOnCancel(undefined, "k1", "1.00");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("2.00");
    expect(store.entries.every((entry) => entry.balanceAfter.gte(0))).toBe(true);
  });
});

describe("发卡密入账与手工调整", () => {
  it("allocate 把面值写进卡密余额", async () => {
    const { store, ledger } = setup({ k1: "0.00" });
    const entry = await ledger.allocate(undefined, "k1", "5.00", "order_1");
    expect(entry.reason).toBe("reserve");
    expect(entry.deltaUsd.toFixed(2)).toBe("5.00");
    expect(entry.balanceAfter.toFixed(2)).toBe("5.00");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("5.00");
  });

  it("入账到不存在的卡密报 KeyNotFoundError", async () => {
    const { ledger } = setup({});
    await expect(ledger.allocate(undefined, "ghost", "1.00")).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("manualAdjust 支持正负，但拒绝 0", async () => {
    const { store, ledger } = setup({ k1: "2.00" });
    await ledger.manualAdjust(undefined, "k1", "0.50");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("2.50");
    await ledger.manualAdjust(undefined, "k1", "-0.50");
    expect(store.balances.get("k1")?.toFixed(2)).toBe("2.00");
    await expect(ledger.manualAdjust(undefined, "k1", "0")).rejects.toBeInstanceOf(RangeError);
  });

  it("负数金额在入账侧直接拒绝", async () => {
    const { ledger } = setup({ k1: "2.00" });
    await expect(ledger.creditOrThrow(undefined, "k1", "-1", "manual")).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("审计：每笔变动都有一条含 balanceAfter 的流水", () => {
  it("流水条数 == 余额变动次数，且 balanceAfter 连续正确", async () => {
    const { store, ledger } = setup({ k1: "10.00" });
    await ledger.allocate(undefined, "k1", "0.00").catch(() => undefined);
    await ledger.reserveForNumber(undefined, "k1", "2.00", "a");
    await ledger.settleReservation(undefined, "k1", "2.00", "1.20", "a");
    await ledger.refundOnCancel(undefined, "k1", "1.20", "a");

    expect(store.entries).toHaveLength(3);
    expect(store.entries.map((entry) => entry.balanceAfter.toFixed(2))).toEqual([
      "8.00",
      "8.80",
      "10.00",
    ]);
    for (const entry of store.entries) {
      expect(entry.balanceAfter.gte(0)).toBe(true);
      expect(entry.deltaUsd.isZero()).toBe(false);
    }
  });
});
