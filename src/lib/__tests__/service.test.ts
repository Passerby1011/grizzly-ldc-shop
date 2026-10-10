import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config";
import { GRIZZLY_STATUS, GrizzlyApiError, type GrizzlyClient } from "../grizzly";
import { ApiError } from "../http";
import { cancelActivation, pollActivation } from "../service";

const mocks = vi.hoisted(() => {
  const activation = {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const prisma = {
    activation,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ activation })),
  };
  return { activation, prisma };
});

vi.mock("../db", () => ({ getPrisma: () => mocks.prisma }));

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
