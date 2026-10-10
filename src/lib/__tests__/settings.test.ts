/**
 * 站点设置读取优先级与写入行为。
 *
 * 关键不变量：
 *   Setting 表 > 环境变量 > 硬编码默认
 * 并且数据库不可用时必须静默回退（不能把站点拖垮）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingKey } from "../settings";

/** 每行 key/value；由测试直接操纵。 */
const store = new Map<string, string>();

const findMany = vi.fn(async () =>
  [...store.entries()].map(([key, value]) => ({ key, value, updatedAt: new Date() })),
);
const upsert = vi.fn(async ({ where, create, update }: any) => {
  store.set(where.key, create?.value ?? update?.value);
  return { key: where.key, value: store.get(where.key)!, updatedAt: new Date() };
});

vi.mock("../db", () => ({
  getPrisma: () => ({ setting: { findMany, upsert } }),
}));

import { resetConfigCache } from "../config";
import {
  getEnvFallbackSettings,
  getSiteSettings,
  getSiteSettingsView,
  resetSettingsCache,
  updateSiteSettings,
} from "../settings";

const ENV_KEYS = [
  "GRIZZLY_API_KEY",
  "LDC_PID",
  "LDC_KEY",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "RATE_LDC_PER_USD",
  "MARKUP_PCT",
  "CANCEL_LOCK_SECONDS",
  "SAFETY_BUFFER_USD",
  "FACE_VALUE_PRESETS",
] as const;

const baseline: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) baseline[k] = process.env[k];
  // 给一份最小可解析的配置，避免 getConfig() 抛错
  process.env.GRIZZLY_API_KEY = "test-grizzly-key";
  process.env.LDC_PID = "test-ldc-pid";
  process.env.LDC_KEY = "test-ldc-key";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.ADMIN_TOKEN = "test-admin-token";

  store.clear();
  findMany.mockClear();
  upsert.mockClear();
  findMany.mockImplementation(async () =>
    [...store.entries()].map(([key, value]) => ({ key, value, updatedAt: new Date() })),
  );
  resetSettingsCache();
  resetConfigCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (baseline[k] === undefined) delete process.env[k];
    else process.env[k] = baseline[k];
  }
  resetSettingsCache();
  resetConfigCache();
});

describe("getSiteSettings 读取优先级", () => {
  it("DB 有值时优先于环境变量", async () => {
    process.env.RATE_LDC_PER_USD = "2.50";
    store.set("rate_ldc_per_usd", "3.33");
    const s = await getSiteSettings();
    expect(s.rateLdcPerUsd.toFixed(2)).toBe("3.33");
  });

  it("DB 无值时回退环境变量", async () => {
    process.env.RATE_LDC_PER_USD = "2.50";
    const s = await getSiteSettings();
    expect(s.rateLdcPerUsd.toFixed(2)).toBe("2.50");
  });

  it("DB 与环境变量都无值时回退硬编码默认", async () => {
    delete process.env.RATE_LDC_PER_USD;
    delete process.env.CANCEL_LOCK_SECONDS;
    const s = await getSiteSettings();
    expect(s.rateLdcPerUsd.toFixed(2)).toBe("1.10");
    expect(s.cancelLockSeconds).toBe(90);
  });

  it("DB 读取抛错时静默回退，不抛异常", async () => {
    process.env.RATE_LDC_PER_USD = "2.50";
    findMany.mockRejectedValueOnce(new Error('relation "Setting" does not exist'));
    const s = await getSiteSettings();
    expect(s.rateLdcPerUsd.toFixed(2)).toBe("2.50");
  });

  it("DB 值非法时回退（负汇率 / NaN / 非数字锁定秒数）", async () => {
    process.env.RATE_LDC_PER_USD = "1.10";
    store.set("rate_ldc_per_usd", "-1");
    store.set("markup_pct", "NaN");
    store.set("cancel_lock_seconds", "abc");
    const s = await getSiteSettings();
    expect(s.rateLdcPerUsd.toFixed(2)).toBe("1.10");
    expect(s.markupPct).toBe(0);
    expect(s.cancelLockSeconds).toBe(90);
  });

  it("面值档位：DB 覆盖 + 非法值回退默认", async () => {
    store.set("face_value_presets", "2,4,6");
    expect((await getSiteSettings()).faceValuePresets).toEqual([2, 4, 6]);

    resetSettingsCache();
    store.set("face_value_presets", "abc,,");
    expect((await getSiteSettings()).faceValuePresets).toEqual([1, 3, 5, 10]);
  });

  it("30 秒进程内缓存：两次读取只查一次库", async () => {
    await getSiteSettings();
    await getSiteSettings();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("getSiteSettingsView", () => {
  it("返回 effective / envFallback / fromDb 三段，fromDb 只含库里显式覆盖的键", async () => {
    process.env.RATE_LDC_PER_USD = "2.00";
    store.set("rate_ldc_per_usd", "9.99");
    const view = await getSiteSettingsView();

    expect(Object.keys(view).sort()).toEqual(["effective", "envFallback", "fromDb"]);
    expect(view.effective.rateLdcPerUsd.toFixed(2)).toBe("9.99");
    expect(view.envFallback.rateLdcPerUsd.toFixed(2)).toBe("2.00");
    expect(view.fromDb).toEqual({ rate_ldc_per_usd: "9.99" });
  });

  it("配置缺失（缺 LDC_KEY）时 envFallback 仍可用，不抛异常", async () => {
    delete process.env.LDC_KEY;
    resetConfigCache();
    const fallback = getEnvFallbackSettings();
    expect(fallback.rateLdcPerUsd.toFixed(2)).toBe("1.10");
  });
});

describe("updateSiteSettings", () => {
  it("写入后缓存失效，再读是新值", async () => {
    await getSiteSettings(); // 填充缓存
    const next = await updateSiteSettings({ rateLdcPerUsd: "5.00" as any });
    expect(next.rateLdcPerUsd.toFixed(2)).toBe("5.00");
    // 库里以固定小数位存储，断言数值而非字面格式
    expect(Number(store.get("rate_ldc_per_usd"))).toBe(5);
    expect((await getSiteSettings()).rateLdcPerUsd.toFixed(2)).toBe("5.00");
  });

  it("只写显式传入的键，不把环境变量兜底值固化进库", async () => {
    await updateSiteSettings({ markupPct: 12 });
    expect([...store.keys()]).toEqual(["markup_pct"]);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("非法值拒绝入库", async () => {
    await updateSiteSettings({ rateLdcPerUsd: "-3" as any });
    expect(store.has("rate_ldc_per_usd")).toBe(false);
  });
});

describe("updateSiteSettings：每个可写键都必须真的落库", () => {
  /*
   * 回归：auto_cancel_minutes 加入时，updateSiteSettings 的 touched 白名单
   * switch 里漏了这个 case，落到 default: return false → 永远不 upsert。
   * 表现是「后台显示改成功了（merged 里是新值），但刷新后回到旧值」。
   * 这类"写入路径漏一个分支"的 bug 单测不覆盖就只能在端到端里发现。
   */
  const cases: Array<[SettingKey, Record<string, unknown>]> = [
    ["rate_ldc_per_usd", { rateLdcPerUsd: "2.50" }],
    ["markup_pct", { markupPct: 12 }],
    ["cancel_lock_seconds", { cancelLockSeconds: 45 }],
    ["safety_buffer_usd", { safetyBufferUsd: "0.75" }],
    ["auto_cancel_minutes", { autoCancelMinutes: 16 }],
    ["face_value_presets", { faceValuePresets: [1, 2, 5] }],
  ];

  it.each(cases)("%s 写入后能从库里读回", async (key, patch) => {
    store.clear();
    resetSettingsCache();
    upsert.mockClear();

    await updateSiteSettings(patch as never);

    expect(upsert, `${key} 应触发一次 upsert`).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].where.key).toBe(key);
    expect(store.get(key), `${key} 应写进 store`).toBeTruthy();

    /* 再读一次应拿到刚写的值（而不是回退到 env/默认） */
    resetSettingsCache();
    const view = await getSiteSettingsView();
    expect(view.fromDb[key], `${key} 应出现在 fromDb`).toBeTruthy();
  });

  it("autoCancelMinutes = 0 是合法值（表示关闭），必须能存", async () => {
    store.clear();
    resetSettingsCache();
    upsert.mockClear();

    await updateSiteSettings({ autoCancelMinutes: 0 } as never);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(store.get("auto_cancel_minutes")).toBe("0");

    resetSettingsCache();
    const settings = await getSiteSettings();
    expect(settings.autoCancelMinutes).toBe(0);
  });
});
