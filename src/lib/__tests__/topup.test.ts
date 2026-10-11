import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dec } from "../money";
import { fulfillPaidOrder } from "../pool";
import { getLedger } from "../ledger";

/**
 * 充值（topup）的资金安全。
 *
 * 充值与新购共用 fulfillPaidOrder，但语义不同：
 *   新购 —— 付款后新建一张卡
 *   充值 —— 付款后给已存在的卡加余额
 * 这里的每条断言都对应一个真实的资金风险，不是形式检查。
 */

const mocks = vi.hoisted(() => {
  const state = {
    order: null as Record<string, unknown> | null,
    key: null as Record<string, unknown> | null,
    ledgerRows: [] as Record<string, unknown>[],
    /** 记录所有写操作，便于断言"不该发生的没发生" */
    calls: [] as string[],
  };
  const tx = {
    order: {
      findUnique: vi.fn(async () => state.order),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    cardKey: {
      findUnique: vi.fn(async () => state.key),
      create: vi.fn(async () => ({ id: "newkey" })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    keyLedger: {
      findFirst: vi.fn(async () => state.ledgerRows[0] ?? null),
      aggregate: vi.fn(async () => ({ _sum: { deltaUsd: dec(0) } })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "led-new",
        ...data,
        balanceAfter: dec(6),
      })),
    },
    poolReservation: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(async () => [{ balanceUsd: dec(10) }]),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { state, tx, prisma };
});

vi.mock("../db", () => ({ getPrisma: () => mocks.prisma }));
vi.mock("../config", async (io) => {
  const actual = await io<typeof import("../config")>();
  return {
    ...actual,
    getConfig: () => ({
      GRIZZLY_API_KEY: "k",
      LDC_PID: "p",
      LDC_KEY: "s",
      ADMIN_TOKEN: "a",
      CRON_SECRET: "c",
      DATABASE_URL: "postgresql://u:p@localhost:5432/d",
      RATE_LDC_PER_USD: 1.1,
      MARKUP_PCT: 0,
      CANCEL_LOCK_SECONDS: 90,
      SAFETY_BUFFER_USD: 0.5,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      notifyUrl: "http://localhost:3000/api/pay/notify",
    }),
  };
});

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: "o1",
    outTradeNo: "GS-TEST",
    kind: "topup",
    status: "pending",
    faceUsd: dec("5.00"),
    amountLdc: dec("5.50"),
    keyId: null,
    targetKeyId: "k1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.order = orderRow();
  mocks.state.key = { id: "k1", codePrefix: "GS-AAAA", status: "active", balanceUsd: dec("1.00") };
  mocks.state.ledgerRows = [];
});

describe("fulfillPaidOrder：充值到账", () => {
  it("给目标卡密加余额，而不是新建卡", async () => {
    const spy = vi.spyOn(getLedger(), "topUp");

    const r = await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    /* 第一个参数是事务客户端（对象），后三个才是我们要断言的 */
    const call = spy.mock.calls[0];
    expect(call[1]).toBe("k1");
    expect(String(call[2])).toBe("5");
    expect(call[3]).toBe("o1");
    /* 绝不能建新卡 */
    expect(mocks.tx.cardKey.create).not.toHaveBeenCalled();
    expect(r.alreadyPaid).toBe(false);
    expect(r.keyId).toBe("k1");
  });

  it("充值订单不下发卡密明文（code 必须为 null）", async () => {
    const r = await fulfillPaidOrder({ orderId: "o1", trace: "notify" });
    expect(r.code).toBeNull();
  });

  it("二次幂等：已存在本订单的 topup 流水时不再加钱", async () => {
    mocks.state.ledgerRows = [{ id: "led1" }];
    const spy = vi.spyOn(getLedger(), "topUp");

    const r = await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    expect(spy).not.toHaveBeenCalled();
    expect(r.alreadyPaid).toBe(true);
  });

  it("订单已不是 pending（重复通知）→ alreadyPaid，不加钱", async () => {
    mocks.tx.order.updateMany.mockResolvedValueOnce({ count: 0 });
    const spy = vi.spyOn(getLedger(), "topUp");

    const r = await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    expect(spy).not.toHaveBeenCalled();
    expect(r.alreadyPaid).toBe(true);
  });

  it("给已作废的卡充值 → 自动恢复为 active 并重新占用池", async () => {
    mocks.state.key = { id: "k1", codePrefix: "GS-AAAA", status: "revoked", balanceUsd: dec("0") };

    await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    expect(mocks.tx.cardKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "k1" }, data: { status: "active" } }),
    );
    const reserveCalls = mocks.tx.poolReservation.updateMany.mock.calls as unknown as Array<[
      { where?: { keyId?: string }; data?: { released?: boolean } },
    ]>;
    const reserveCall = reserveCalls[reserveCalls.length - 1]?.[0];
    expect(reserveCall?.where?.keyId).toBe("k1");
    expect(reserveCall?.data?.released).toBe(false);
  });

  it("缺少目标卡密的充值订单 → 直接抛错，不静默通过", async () => {
    mocks.state.order = orderRow({ targetKeyId: null });
    await expect(fulfillPaidOrder({ orderId: "o1", trace: "notify" })).rejects.toThrow(/目标卡密/);
  });
});

describe("fulfillPaidOrder：新购不受充值改动影响", () => {
  it("purchase 订单仍然新建卡密并下发明文", async () => {
    mocks.state.order = orderRow({ kind: "purchase", targetKeyId: null });
    mocks.tx.cardKey.create.mockResolvedValue({ id: "newkey" });

    const r = await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    expect(mocks.tx.cardKey.create).toHaveBeenCalled();
    expect(r.code).toBeTruthy();
    expect(r.keyId).toBe("newkey");
  });
});

describe("充值金额规则与买卡一致", () => {
  it("最小 0.01，非 0.01 整数倍被拒（同一套 checkFaceAmount）", async () => {
    const { checkFaceAmount } = await import("../face-value");
    expect(checkFaceAmount("0.01").ok).toBe(true);
    expect(checkFaceAmount("0.015").ok).toBe(false);
  });

  it("充值走同一个汇率来源（站点设置），不会出现前台后台价不一致", () => {
    const src = readFileSync("src/lib/service.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function createTopupOrder"), src.indexOf("export async function createPayOrder"));
    expect(fn).toContain("getSiteSettings()");
    expect(fn).not.toContain("config.RATE_LDC_PER_USD");
  });

  it("充值不接受前端传 keyId（目标卡密只能来自会话）", () => {
    const src = readFileSync("src/app/api/key/topup/route.ts", "utf8");
    expect(src).toContain("requireSession(request)");
    /* body schema 里不得有 keyId */
    /* 只取 schema 定义里的字段名，别把注释和 handler 一起扫进来 */
    const schema = src.slice(src.indexOf("BodySchema"), src.indexOf("export const POST"));
    const fields = [...schema.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(["amountUsd"]);
  });
});

describe("充值必须同时累加面值", () => {
  /*
   * 回归：曾经只加 balanceUsd、不加 faceUsd。
   * 实测 GS-XWT9：买卡 $0.15 + 充值 $0.12，面值却一直显示 $0.15，
   * 后台看不出这张卡的真实体量（老板就是因此以为充值没到账）。
   */
  it("给目标卡密的 faceUsd 做原子 increment", async () => {
    mocks.state.order = orderRow();
    mocks.state.key = { id: "k1", codePrefix: "GS-AAAA", status: "active", balanceUsd: dec("1.00"), faceUsd: dec("1.00") };
    mocks.tx.cardKey.update.mockClear();

    await fulfillPaidOrder({ orderId: "o1", trace: "notify" });

    /* mock 的 update 返回 {} 会让 TS 把 calls 推断成 never[]，这里显式断言 */
    const calls = mocks.tx.cardKey.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: { faceUsd?: unknown } }]
    >;
    const incCall = calls.find((c) => c[0]?.data?.faceUsd && typeof c[0].data.faceUsd === "object");
    expect(incCall, "必须对 faceUsd 做 increment").toBeTruthy();
    expect(incCall![0].where.id).toBe("k1");
  });

  it("面值用 increment 而非读改写（防并发丢更新）", () => {
    const src = readFileSync("src/lib/pool.ts", "utf8");
    const fn = src.slice(src.indexOf('if (order.kind === "topup")'), src.indexOf("/* ---- 新购"));
    expect(fn).toContain("faceUsd: { increment: order.faceUsd }");
  });
});
