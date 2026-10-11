import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config";
import { GRIZZLY_STATUS, GrizzlyApiError, type GrizzlyClient } from "../grizzly";
import { ApiError } from "../http";
import { readFileSync } from "node:fs";
import { getEnvFallbackSettings } from "../settings";
import { cancelActivation, pollActivation, reconcileAbandonedActivations, sweepStaleActivations } from "../service";

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

vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return {
    ...actual,
    getSiteSettings: vi.fn(async () => ({ autoCancelMinutes: 16 })),
  };
});

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
  /*
   * sweep 现在复用 recycleOneActivation（与精确闹钟同一条逻辑），
   * 该函数会先 findUnique 取这条激活再判断，所以 mock 必须让它能取到。
   */
  beforeEach(() => {
    mocks.activation.findUnique.mockResolvedValue(
      activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) }),
    );
  });

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

  it("上游已自行取消 → sweep 不再收口（退款改由 reconcileAbandonedActivations 负责）", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow({ createdAt: new Date(Date.now() - 17 * 60_000) })]);
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "CANCEL" });

    const r = await sweepStaleActivations();

    /* 关键：不能把上游已取消的号标成 expired —— 那会吞掉买家的钱。
       退款口径只保留在 reconciler 一处。 */
    expect(mocks.grizzly.setStatus).not.toHaveBeenCalled();
    expect(r.recycled).toBe(0);
    expect(r.scanned).toBe(1);
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

describe("超时回收：按号龄判定，不依赖定时器与巡检频率", () => {
  /*
   * 曾试图用进程内存 setTimeout 排精确闹钟 —— 在 serverless（Vercel）里不成立：
   * 请求上下文结束后事件循环不再保证定时器存活，unref() 更是主动放弃。
   * 实测取号 100 秒后仍是 waiting，证明闹钟根本没跑。
   *
   * 正确做法：判定永远按「号龄 = now - 该号码自己的 createdAt」，
   * 由两个高频入口触发：
   *   1) pollActivation —— 买家等码时每 4 秒轮询，当场就能判
   *   2) /api/cron/sweep —— 外部定时器捞被遗弃（关掉页面）的激活
   */
  it("pollActivation 内按号龄判定并回收（源码级）", () => {
    const src = readFileSync("src/lib/service.ts", "utf8");
    const poll = src.slice(src.indexOf("export async function pollActivation"), src.indexOf("async function fetchSmsText"));
    expect(poll).toContain("activation.createdAt.getTime() + autoCancelMinutes * 60_000");
    expect(poll).toContain("await recycleOneActivation(activation.id)");
  });

  it("不再依赖进程内定时器（serverless 下不可靠）", () => {
    const src = readFileSync("src/lib/service.ts", "utf8");
    expect(src).not.toContain("scheduleAutoCancel");
    expect(src).not.toContain("autoCancelTimers");
  });

  it("sweep 与轮询共用同一回收逻辑，避免两条路径行为漂移", () => {
    const src = readFileSync("src/lib/service.ts", "utf8");
    const sweep = src.slice(src.indexOf("export async function sweepStaleActivations"));
    expect(sweep).toContain("await recycleOneActivation(activation.id)");
  });

  it("默认关闭（0），启用时的值必须显著小于上游 20 分钟红线", () => {
    const view = getEnvFallbackSettings();
    /* 老板 2026-10-11 决定先不启用，默认 0 = 关闭 */
    expect(view.autoCancelMinutes).toBe(0);
    /* 若将来启用，18 以内才安全（上游 20 分钟硬截止） */
    expect(view.autoCancelMinutes).toBeLessThanOrEqual(18);
  });

  it("autoCancelInSeconds 从本号码取号时刻算起", async () => {
    mocks.activation.findUnique.mockResolvedValue(activationRow());
    mocks.activation.update.mockResolvedValue(activationRow());
    const grizzly = grizzlyStub();
    grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });

    const view = await pollActivation({ keyId: "key1", activationId: "act1", grizzly: grizzly.client });

    /* 刚取号 → 剩余应接近 autoCancelMinutes 整分钟 */
    expect(view.autoCancelInSeconds).not.toBeNull();
    expect(view.autoCancelInSeconds).toBeGreaterThan(0);
    expect(view.autoCancelAt).toBeTruthy();
  });
});

describe("reconcileAbandonedActivations：弃单核账（资金安全，独立于保底回收开关）", () => {
  /*
   * 背景：本地激活状态只靠买家浏览器轮询更新。买家一切走，本地就永远冻在
   * waiting，而上游早已出码或取消。实测 wa/151 那笔 $0.12 卡了一整天。
   */

  it("上游已取消 + 过了确认窗口 → 退款给卡密（老板定的口径）", async () => {
    mocks.activation.findMany.mockResolvedValue([
      activationRow({ createdAt: new Date(Date.now() - 30 * 60_000), costUsd: "0.12" }),
    ]);
    mocks.activation.findUnique.mockResolvedValue(activationRow({ costUsd: "0.12" }));
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "CANCEL" });

    const r = await reconcileAbandonedActivations();

    expect(r.refunded).toBe(1);
    expect(r.refundedUsd).toBe("0.12");
  });

  it("上游已取消但还在确认窗口内 → 不退款（上游可能只是暂时可取消态）", async () => {
    mocks.activation.findMany.mockResolvedValue([
      /* 刚取号 1 分钟，实测可取消窗口 64s~334s 浮动，此时退款有风险 */
      activationRow({ createdAt: new Date(Date.now() - 1 * 60_000) }),
    ]);
    mocks.grizzly.getStatus.mockResolvedValue({ state: "CANCEL" });

    const r = await reconcileAbandonedActivations();

    expect(r.refunded).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("上游其实已出码 → 补记，绝不让买家的码丢掉", async () => {
    mocks.activation.findMany.mockResolvedValue([
      activationRow({ createdAt: new Date(Date.now() - 30 * 60_000) }),
    ]);
    mocks.activation.updateMany.mockResolvedValue({ count: 1 });
    mocks.grizzly.getStatus.mockResolvedValue({ state: "OK", code: "984183" });

    const r = await reconcileAbandonedActivations();

    expect(r.completed).toBe(1);
    const call = mocks.activation.updateMany.mock.calls.at(-1)![0] as {
      where: { status: string };
      data: { status: string; code: string };
    };
    /* 条件 UPDATE：只有仍是 waiting 才能认领，防止与买家轮询抢同一单 */
    expect(call.where.status).toBe("waiting");
    expect(call.data.status).toBe("ok");
    expect(call.data.code).toBe("984183");
  });

  it("上游仍等待中 → 不动它，留给买家轮询与保底回收", async () => {
    mocks.activation.findMany.mockResolvedValue([activationRow()]);
    mocks.grizzly.getStatus.mockResolvedValue({ state: "WAIT_CODE" });

    const r = await reconcileAbandonedActivations();

    expect(r.refunded).toBe(0);
    expect(r.completed).toBe(0);
    expect(mocks.activation.updateMany).not.toHaveBeenCalled();
  });

  it("没有 waiting 记录 → 直接返回，不打上游", async () => {
    mocks.activation.findMany.mockResolvedValue([]);

    const r = await reconcileAbandonedActivations();

    expect(r.scanned).toBe(0);
    expect(mocks.grizzly.getStatus).not.toHaveBeenCalled();
  });
});
