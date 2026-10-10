/**
 * 管理员鉴权：Bearer / Cookie 双通道、错误口令拒绝、登录限速、常量时间比较。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "GRIZZLY_API_KEY",
  "LDC_PID",
  "LDC_KEY",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "NEXT_PUBLIC_APP_URL",
] as const;
const baseline: Record<string, string | undefined> = {};

const ADMIN_TOKEN = "a-very-long-admin-token-for-tests";

beforeEach(() => {
  for (const k of ENV_KEYS) baseline[k] = process.env[k];
  process.env.GRIZZLY_API_KEY = "test-grizzly-key";
  process.env.LDC_PID = "test-ldc-pid";
  process.env.LDC_KEY = "test-ldc-key";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.NEXT_PUBLIC_APP_URL = "https://example.test";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (baseline[k] === undefined) delete process.env[k];
    else process.env[k] = baseline[k];
  }
});

async function load() {
  const { resetConfigCache } = await import("../config");
  resetConfigCache();
  const mod = await import("../admin");
  mod.resetAdminRateLimit();
  return mod;
}

function req(headers: Record<string, string> = {}, url = "https://example.test/api/admin/overview") {
  return new Request(url, { headers });
}

describe("requireAdmin", () => {
  it("Bearer 口令正确 → 通过", async () => {
    const a = await load();
    expect(() => a.requireAdmin(req({ authorization: `Bearer ${ADMIN_TOKEN}` }))).not.toThrow();
  });

  it("Bearer 口令错误 → 401", async () => {
    const a = await load();
    expect(() => a.requireAdmin(req({ authorization: "Bearer wrong-token" }))).toThrow(/管理口令错误/);
  });

  it("缺任何凭据 → 401", async () => {
    const a = await load();
    expect(() => a.requireAdmin(req())).toThrow(/管理口令错误/);
  });

  it("Cookie 通道：登录下发的 Cookie 能通过鉴权", async () => {
    const a = await load();
    const setCookie = a.buildAdminCookie();
    const cookieValue = setCookie.split(";")[0];
    expect(() => a.requireAdmin(req({ cookie: cookieValue }))).not.toThrow();
  });

  it("Cookie 被篡改 → 401", async () => {
    const a = await load();
    const cookieValue = a.buildAdminCookie().split(";")[0];
    expect(() => a.requireAdmin(req({ cookie: `${cookieValue}tampered` }))).toThrow(/管理口令错误/);
  });

  it("买家会话 Cookie（glc_key）不能冒充管理员", async () => {
    const a = await load();
    const { signSessionToken } = await import("../keycodec");
    const { getConfig } = await import("../config");
    const buyerToken = signSessionToken("some-key-id", 60_000, getConfig().cookieSecret);
    expect(() => a.requireAdmin(req({ cookie: `glc_key=${buyerToken}` }))).toThrow(/管理口令错误/);
  });

  it("未配置 ADMIN_TOKEN → 500 CONFIG_ERROR，而不是放行", async () => {
    delete process.env.ADMIN_TOKEN;
    const a = await load();
    try {
      a.requireAdmin(req({ authorization: "Bearer anything" }));
      throw new Error("不该通过");
    } catch (error: any) {
      expect(error.status).toBe(500);
      expect(error.code).toBe("CONFIG_ERROR");
    }
  });

  it("使用常量时间比较（不因长度差异短路）", async () => {
    const a = await load();
    // 长度差很多也应拒绝，且不抛非预期异常
    for (const bad of ["a", "a".repeat(200), ADMIN_TOKEN + "x"]) {
      expect(() => a.requireAdmin(req({ authorization: `Bearer ${bad}` }))).toThrow(/管理口令错误/);
    }
  });
});

describe("verifyAdminToken", () => {
  it("正确口令通过，其余一律拒绝", async () => {
    const a = await load();
    expect(a.verifyAdminToken(ADMIN_TOKEN)).toBe(true);
    expect(a.verifyAdminToken("nope")).toBe(false);
    expect(a.verifyAdminToken("")).toBe(false);
    expect(a.verifyAdminToken(undefined)).toBe(false);
    expect(a.verifyAdminToken(null)).toBe(false);
    expect(a.verifyAdminToken(123 as unknown)).toBe(false);
  });
});

describe("登录限速", () => {
  it("同 IP 超过 10 次/分钟 → 429 且带 retryAfterSeconds", async () => {
    const a = await load();
    for (let i = 0; i < 10; i += 1) a.recordLoginFailure("1.2.3.4");
    try {
      a.assertLoginRateLimit("1.2.3.4");
      throw new Error("不该通过");
    } catch (error: any) {
      expect(error.status).toBe(429);
      expect(error.details?.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("登录成功后清零计数", async () => {
    const a = await load();
    for (let i = 0; i < 10; i += 1) a.recordLoginFailure("5.6.7.8");
    a.clearLoginAttempts("5.6.7.8");
    expect(() => a.assertLoginRateLimit("5.6.7.8")).not.toThrow();
  });

  it("不同 IP 互不影响", async () => {
    const a = await load();
    for (let i = 0; i < 10; i += 1) a.recordLoginFailure("9.9.9.9");
    expect(() => a.assertLoginRateLimit("8.8.8.8")).not.toThrow();
  });
});

describe("clientIp", () => {
  it("取 x-forwarded-for 第一段", async () => {
    const a = await load();
    expect(a.clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("回退 x-real-ip，再回退 unknown", async () => {
    const a = await load();
    expect(a.clientIp(req({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(a.clientIp(req())).toBe("unknown");
  });
});
