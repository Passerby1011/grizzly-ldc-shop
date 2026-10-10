import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config";
import { GRIZZLY_STATUS, GrizzlyApiError, type GrizzlyClient } from "../grizzly";
import { ApiError } from "../http";
import { readFileSync } from "node:fs";
import { cancelActivation, pollActivation, sweepStaleActivations } from "../service";

const mocks = vi.hoisted(() => {
  const activation = {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  };
  const prisma = {
    activation,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ activation })),
  };
  const grizzly = { setStatus: vi.fn(), getStatus: vi.fn() };
  return { activation, prisma, grizzly };
});

vi.mock("../db", () => ({ getPrisma: () => mocks.prisma }));

/* 保底回收用模块单例客户端 + 站点设置，这里替换掉 */
vi.mock("../grizzly", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grizzly")>();
  return { ...actual, getGrizzlyClient: () => mocks.grizzly };
});

vi.mock("../settings", () => ({
  getSiteSettings: vi.fn(async () => ({ autoCancelMinutes: 16 })),
}));

vi.mock("../ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ledger")>();
  const { dec } = await import("../money");
  return {
    ...actual,
    getLedger: () => ({
      refundOnCancel: vi.fn(async () => ({ balanceAfter: dec("9.99") })),
    }),
  };
});

function activationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "act1",
    keyId: "key1",
    grizzlyId: "g1",
    service: "tg",
    country: "0",
    phone: "79990001122",
    reservedUsd: "0.50",
    costUsd: "0.13",
    status: "waiting",
    code: null,
    smsText: null,
    lastPolledAt: null,
    createdAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

function grizzlyStub() {
  const setStatus = vi.fn();
  const getStatus = vi.fn();
  return {
    setStatus,
    getStatus,
    client: { setStatus, getStatus } as unknown as GrizzlyClient,
  };
}

beforeAll(() => {
  process.env.GRIZZLY_API_KEY = "test-key";
  process.env.LDC_PID = "test-pid";
  process.env.LDC_KEY = "test-secret";
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/test";
  process.env.ADMIN_TOKEN = "test-admin-token";
  process.env.CANCEL_LOCK_SECONDS = "90";
  resetConfigCache();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelActivation：本地取消闸门（CANCEL_LOCK_SECONDS）", () => {
  it("锁定窗口内直接 409，且不调用上游", async () => {
    mocks.activation.findUnique.mockResolvedValue(activationRow());
    const grizzly = grizzlyStub();

    const caught = await cancelActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("CONFLICT");
    expect((apiError.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(grizzly.setStatus).not.toHaveBeenCalled();
    expect(grizzly.getStatus).not.toHaveBeenCalled();
  });

  it("锁定窗口外正常调用上游并回补", async () => {
    mocks.activation.findUnique.mockResolvedValue(
      activationRow({ createdAt: new Date(Date.now() - 91_000) }),
    );
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    const grizzly = grizzlyStub();
    grizzly.setStatus.mockResolvedValue("CANCEL");

    const result = await cancelActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    });

    expect(grizzly.setStatus).toHaveBeenCalledWith("g1", GRIZZLY_STATUS.CANCEL);
    expect(result.status).toBe("cancelled");
    expect(result.refundedUsd).toBe("0.13");
    expect(result.balanceUsd).toBe("9.99");
  });

  it("上游仍返回 EARLY_CANCEL_DENIED → 409 + retryAfterSeconds，不冒泡成 UNKNOWN", async () => {
    mocks.activation.findUnique.mockResolvedValue(
      activationRow({ createdAt: new Date(Date.now() - 91_000) }),
    );
    const grizzly = grizzlyStub();
    grizzly.setStatus.mockRejectedValue(
      new GrizzlyApiError("EARLY_CANCEL_DENIED", "EARLY_CANCEL_DENIED"),
    );
    grizzly.getStatus.mockRejectedValue(new Error("上游状态查询失败"));

    const caught = await cancelActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(409);
    expect((apiError.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(15);
  });
});

describe("pollActivation：取消倒计时字段（服务端算，刷新不丢）", () => {
  it("刚取号 → 剩余秒数 > 0，锁定时间点在未来", async () => {
    mocks.activation.findUnique.mockResolvedValue(activationRow());
    mocks.activation.update.mockResolvedValue(activationRow());
    const grizzly = grizzlyStub();
    grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });

    const view = await pollActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    });

    expect(view.cancelAvailableInSeconds).toBeGreaterThan(0);
    expect(view.cancelAvailableInSeconds).toBeLessThanOrEqual(90);
    expect(Date.parse(view.cancelLockedUntil)).toBeGreaterThan(Date.now());
  });

  it("超过锁定窗口 → 剩余秒数归零", async () => {
    mocks.activation.findUnique.mockResolvedValue(
      activationRow({ createdAt: new Date(Date.now() - 91_000) }),
    );
    mocks.activation.update.mockResolvedValue(activationRow());
    const grizzly = grizzlyStub();
    grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });

    const view = await pollActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    });

    expect(view.cancelAvailableInSeconds).toBe(0);
    expect(Date.parse(view.cancelLockedUntil)).toBeLessThan(Date.now());
  });
});

describe("pollActivation：并发漏洞（收到码与取消同时发生）", () => {
  /*
   * 曾经的缺陷：轮询拿到 STATUS_OK 后无条件把状态写回 ok 并下发验证码。
   * 若用户在此之间点了取消（已退款、本地置 cancelled），就会同时拿到
   * 「退款 + 验证码」，卖家既付了上游成本又退了款。
   * 修法：先用条件 UPDATE 认领（只有仍是 waiting 才能成 ok）。
   */
  it("认领成功 → 通知上游完成 + 下发验证码", async () => {
    mocks.activation.findUnique.mockResolvedValue(activationRow());
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.activation.update.mockResolvedValue(activationRow({ status: "ok", code: "123456" }));
    const grizzly = grizzlyStub();
    grizzly.getStatus.mockResolvedValue({ state: "OK", code: "123456" });

    const view = await pollActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    });

    expect(mocks.activation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "act1", status: "waiting" } }),
    );
    expect(grizzly.setStatus).toHaveBeenCalledWith("g1", GRIZZLY_STATUS.ACTIVATION);
    expect(view.status).toBe("ok");
  });

  it("认领失败（已被取消）→ 不通知上游、不下发验证码", async () => {
    mocks.activation.findUnique
      .mockResolvedValueOnce(activationRow())
      .mockResolvedValue(activationRow({ status: "cancelled", code: null }));
    mocks.activation.updateMany.mockResolvedValue({ count: 0 });
    const grizzly = grizzlyStub();
    grizzly.getStatus.mockResolvedValue({ state: "OK", code: "123456" });

    const view = await pollActivation({
      keyId: "key1",
      activationId: "act1",
      grizzly: grizzly.client,
    });

    /* 最关键的两条：绝不 setStatus(6)、绝不返回验证码 */
    expect(grizzly.setStatus).not.toHaveBeenCalled();
    expect(view.code).toBeNull();
    expect(view.hint).toContain("不再下发验证码");
  });
});

describe("sweepStaleActivations：保底回收", () => {
  it("超时未收到码 → 取消上游 + 置 expired", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) })]);
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });
    mocks.grizzly.setStatus.mockResolvedValue("CANCEL");

    const r = await sweepStaleActivations();

    expect(mocks.grizzly.setStatus).toHaveBeenCalledWith("g1", GRIZZLY_STATUS.CANCEL);
    expect(mocks.activation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "act1", status: "waiting" },
        data: expect.objectContaining({ status: "expired" }),
      }),
    );
    expect(r.recycled).toBe(1);
  });

  it("期间收到验证码 → 按正常完成，不回收", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) })]);
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "OK", code: "999" });

    const r = await sweepStaleActivations();

    expect(mocks.grizzly.setStatus).toHaveBeenCalledWith("g1", GRIZZLY_STATUS.ACTIVATION);
    expect(r.completed).toBe(1);
    expect(r.recycled).toBe(0);
    /* 认领写的是 ok 而不是 expired */
    expect(mocks.activation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ok" }) }),
    );
  });

  it("上游已自行取消 → 本地收口为 expired（同样不退钱）", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) })]);
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "CANCEL" });

    const r = await sweepStaleActivations();

    expect(mocks.grizzly.setStatus).not.toHaveBeenCalled();
    expect(r.recycled).toBe(1);
  });

  it("上游仍拒绝取消 → deferred，保持 waiting 下次再试", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) })]);
    mocks.grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });
    mocks.grizzly.setStatus.mockRejectedValue(
      new GrizzlyApiError("EARLY_CANCEL_DENIED", "EARLY_CANCEL_DENIED"),
    );

    const r = await sweepStaleActivations();

    expect(r.deferred).toBe(1);
    expect(r.recycled).toBe(0);
    expect(mocks.activation.updateMany).not.toHaveBeenCalled();
  });

  it("autoCancelMinutes = 0 → 关闭，不查库", async () => {
    const settings = await import("../settings");
    vi.mocked(settings.getSiteSettings).mockResolvedValueOnce({ autoCancelMinutes: 0 } as never);

    const r = await sweepStaleActivations();

    expect(r.scanned).toBe(0);
    expect(mocks.activation.findMany).not.toHaveBeenCalled();
  });

  it("源码级：保底回收绝不写账本（不退卡密余额是硬规则）", () => {
    const src = readFileSync("src/lib/service.ts", "utf8");
    const body = src.slice(src.indexOf("export async function sweepStaleActivations"));
    expect(body.length).toBeGreaterThan(200);
    for (const banned of ["refund", "getLedger", "creditOrThrow", "debitOrThrow"]) {
      expect(body, `sweep 里不允许出现 ${banned}`).not.toContain(banned);
    }
  });
});
