/**
 * 站点设置：数据库可热改，优先于环境变量。
 *
 * 读取优先级（固定，勿改）：Setting 表 > 环境变量 > 硬编码默认。
 *
 * 为什么这样设计：部署在 Vercel 上，改环境变量必须重新部署；
 * 老板要的是「后台点一下就生效」，所以可变项落库，环境变量只作兜底与首次默认。
 *
 * 重要：数据库不可用（没跑迁移 / 连不上）时**必须静默回退**，
 * 不能让整个站点起不来；同理，库里存了非法值也回退，不抛异常。
 */
import { getConfig } from "./config";
import { getPrisma } from "./db";
import { dec, toStorageString, type Decimal } from "./money";

/** 可热改的设置键。字符串形式存库。 */
export type SettingKey =
  | "rate_ldc_per_usd"
  | "markup_pct"
  | "cancel_lock_seconds"
  | "cancel_retry_seconds"
  | "safety_buffer_usd"
  | "auto_cancel_minutes"
  | "face_value_presets";

export const SETTING_KEYS: readonly SettingKey[] = [
  "rate_ldc_per_usd",
  "markup_pct",
  "cancel_lock_seconds",
  "cancel_retry_seconds",
  "safety_buffer_usd",
  "auto_cancel_minutes",
  "face_value_presets",
];

/**
 * SettingKey → SiteSettings 字段名。**唯一映射表**。
 *
 * 为什么要有：读合并、写白名单、序列化三处都需要"键列表"，以前各抄一份，
 * 结果 auto_cancel_minutes 加进来时漏了两处 —— 后台显示改成功、库里却没写，
 * 刷新又回到旧值。现在读/写都用 SETTING_KEYS + 这张表推导，新增键只改这三行。
 */
const KEY_TO_FIELD: Record<SettingKey, keyof SiteSettings> = {
  rate_ldc_per_usd: "rateLdcPerUsd",
  markup_pct: "markupPct",
  cancel_lock_seconds: "cancelLockSeconds",
  cancel_retry_seconds: "cancelRetrySeconds",
  safety_buffer_usd: "safetyBufferUsd",
  auto_cancel_minutes: "autoCancelMinutes",
  face_value_presets: "faceValuePresets",
};

export interface SiteSettings {
  /** 1 美元 Grizzly 余额卖多少 LDC（不含 markup）。 */
  rateLdcPerUsd: Decimal;
  /** 叠加在汇率之上的毛利百分比。 */
  markupPct: number;
  /** 取号后可取消的最短等待秒数（实测上游约 60s 拒绝 EARLY_CANCEL_DENIED）。 */
  cancelLockSeconds: number;
  /**
   * 取消失败后的重试锁定秒数（默认 150 = 2.5 分钟）。
   *
   * 上游解锁时机不可预测（实测 64s~334s 浮动）。第一次被拒后锁一小段时间，
   * 到点提示买家再试，避免连点刷上游。
   */
  cancelRetrySeconds: number;
  /** 不可被动用的安全缓冲（美元），防账本推算与真实余额偏差导致超卖。 */
  safetyBufferUsd: Decimal;
  /**
   * 保底回收：取号后多少分钟仍未收到验证码，系统自动取消激活。
   *
   * **默认 0 = 关闭**（老板 2026-10-11 决定先不启用）。
   * 需要时在后台把值调成 16 左右即可，无需改代码/重新部署。
   *
   * 上游硬约束：号码「有效期起只有 20 分钟」，官方 FAQ 说购买后 20 分钟内
   * 才可退款。所以一旦启用，取值必须显著小于 20（留重试余量）。
   * 取消后**不退还**卡密余额 —— 这是老板定的规则，不是 bug。
   */
  autoCancelMinutes: number;
  /** 首页面值档位（美元）。 */
  faceValuePresets: number[];
}

export interface SiteSettingsView {
  /** 当前生效值（DB > env > 默认）。 */
  effective: SiteSettings;
  /** 仅由环境变量/硬编码默认算出的值，供后台对照「我改了会不会覆盖部署配置」。 */
  envFallback: SiteSettings;
  /** 数据库里显式覆盖了哪些键（值为库中原始字符串）。 */
  fromDb: Partial<Record<SettingKey, string>>;
}

/* ------------------------------------------------------------------ */
/* 默认值与环境变量回退                                                 */
/* ------------------------------------------------------------------ */

const HARD_DEFAULTS: {
  rateLdcPerUsd: number;
  markupPct: number;
  cancelLockSeconds: number;
  cancelRetrySeconds: number;
  safetyBufferUsd: number;
  autoCancelMinutes: number;
  faceValuePresets: number[];
} = {
  rateLdcPerUsd: 1.1,
  markupPct: 0,
  cancelLockSeconds: 90,
  cancelRetrySeconds: 150,
  safetyBufferUsd: 0.5,
  autoCancelMinutes: 0,
  faceValuePresets: [1, 3, 5, 10],
};

const CACHE_TTL_MS = 30_000;

function envNumber(fallback: number, raw: string | undefined): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parsePresets(raw: string | undefined): number[] {
  if (!raw) return [...HARD_DEFAULTS.faceValuePresets];
  const list = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return list.length ? list : [...HARD_DEFAULTS.faceValuePresets];
}

/**
 * 环境变量 + 硬编码默认算出的值。
 * 环境变量缺失时读配置会抛 ConfigError（例如没配 LDC_KEY），这里必须兜住，
 * 否则后台连"当前设置"都打不开。
 */
export function getEnvFallbackSettings(): SiteSettings {
  let rate = HARD_DEFAULTS.rateLdcPerUsd;
  let markup = HARD_DEFAULTS.markupPct;
  let lock = HARD_DEFAULTS.cancelLockSeconds;
  let retry = HARD_DEFAULTS.cancelRetrySeconds;
  let buffer = HARD_DEFAULTS.safetyBufferUsd;
  let autoCancel = HARD_DEFAULTS.autoCancelMinutes;
  let presets = [...HARD_DEFAULTS.faceValuePresets];

  try {
    const cfg = getConfig();
    rate = envNumber(HARD_DEFAULTS.rateLdcPerUsd, String(cfg.RATE_LDC_PER_USD));
    markup = envNumber(HARD_DEFAULTS.markupPct, String(cfg.MARKUP_PCT));
    lock = envNumber(HARD_DEFAULTS.cancelLockSeconds, String(cfg.CANCEL_LOCK_SECONDS));
    retry = envNumber(HARD_DEFAULTS.cancelRetrySeconds, process.env.CANCEL_RETRY_SECONDS);
    buffer = envNumber(HARD_DEFAULTS.safetyBufferUsd, String(cfg.SAFETY_BUFFER_USD));
    autoCancel = envNumber(HARD_DEFAULTS.autoCancelMinutes, process.env.AUTO_CANCEL_MINUTES);
    presets = parsePresets(process.env.FACE_VALUE_PRESETS);
  } catch {
    /* 配置不全时用硬编码默认，保证后台可用 */
  }

  return {
    rateLdcPerUsd: dec(rate),
    markupPct: markup,
    cancelLockSeconds: lock,
    cancelRetrySeconds: retry,
    safetyBufferUsd: dec(buffer),
    autoCancelMinutes: autoCancel,
    faceValuePresets: presets,
  };
}

/* ------------------------------------------------------------------ */
/* 解析与校验                                                           */
/* ------------------------------------------------------------------ */

function parseDbValue(key: SettingKey, raw: string, base: SiteSettings): Partial<SiteSettings> {
  switch (key) {
    case "rate_ldc_per_usd": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return {};
      return { rateLdcPerUsd: dec(n) };
    }
    case "markup_pct": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 10000) return {};
      return { markupPct: n };
    }
    case "cancel_lock_seconds": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 3600) return {};
      return { cancelLockSeconds: Math.floor(n) };
    }
    case "cancel_retry_seconds": {
      const n = Number(raw);
      /* 0 = 不锁（不做冷却）；上限 1 小时 */
      if (!Number.isFinite(n) || n < 0 || n > 3600) return {};
      return { cancelRetrySeconds: Math.floor(n) };
    }
    case "safety_buffer_usd": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return {};
      return { safetyBufferUsd: dec(n) };
    }
    case "auto_cancel_minutes": {
      const n = Number(raw);
      /* 0 = 关闭；上限 24h，防止误填一个巨大的值等于没生效 */
      if (!Number.isFinite(n) || n < 0 || n > 1440) return {};
      return { autoCancelMinutes: Math.floor(n) };
    }
    case "face_value_presets": {
      const parsed = parsePresets(raw);
      return parsed.length ? { faceValuePresets: parsed } : {};
    }
    default:
      /* 未知键忽略；base 仅用于类型收窄，不参与计算 */
      void base;
      return {};
  }
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  effective: SiteSettings;
  fromDb: Partial<Record<SettingKey, string>>;
}

let cache: CacheEntry | null = null;

/** 仅供测试：清空进程内缓存。 */
export function resetSettingsCache(): void {
  cache = null;
}

async function loadFromDb(): Promise<Partial<Record<SettingKey, string>>> {
  try {
    const rows = await getPrisma().setting.findMany();
    const out: Partial<Record<SettingKey, string>> = {};
    for (const row of rows) {
      if ((SETTING_KEYS as readonly string[]).includes(row.key)) {
        out[row.key as SettingKey] = row.value;
      }
    }
    return out;
  } catch {
    /* 表不存在 / 连不上 → 静默回退，站点照常可用 */
    return {};
  }
}

/** 读取顺序：Setting 表 > 环境变量 > 硬编码默认。进程内缓存 30 秒。 */
export async function getSiteSettings(): Promise<SiteSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.effective;

  const envBase = getEnvFallbackSettings();
  const fromDb = await loadFromDb();

  const effective: SiteSettings = {
    ...envBase,
    ...SETTING_KEYS.reduce(
      (acc, key) => {
        const raw = fromDb[key];
        if (raw === undefined) return acc;
        return { ...acc, ...parseDbValue(key, raw, envBase) };
      },
      {} as Partial<SiteSettings>,
    ),
  };

  cache = { at: now, effective, fromDb };
  return effective;
}

/** 后台用：附带环境变量回退值，便于对照。 */
export async function getSiteSettingsView(): Promise<SiteSettingsView> {
  const effective = await getSiteSettings();
  const now = Date.now();
  const fromDb = cache && now - cache.at < CACHE_TTL_MS ? cache.fromDb : await loadFromDb();
  return { effective, envFallback: getEnvFallbackSettings(), fromDb };
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

function serialize(key: SettingKey, next: SiteSettings): string {
  switch (key) {
    case "rate_ldc_per_usd":
      return toStorageString(next.rateLdcPerUsd);
    case "markup_pct":
      return String(next.markupPct);
    case "cancel_lock_seconds":
      return String(Math.floor(next.cancelLockSeconds));
    case "cancel_retry_seconds":
      return String(Math.floor(next.cancelRetrySeconds));
    case "safety_buffer_usd":
      return toStorageString(next.safetyBufferUsd);
    case "auto_cancel_minutes":
      return String(Math.floor(next.autoCancelMinutes));
    case "face_value_presets":
      return next.faceValuePresets.join(",");
    default:
      return "";
  }
}

/** 局部更新并立即失效缓存。值以字符串存库。 */
export async function updateSiteSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const current = await getSiteSettings();
  const envBase = getEnvFallbackSettings();

  const merged: SiteSettings = {
    rateLdcPerUsd: patch.rateLdcPerUsd !== undefined ? dec(patch.rateLdcPerUsd) : current.rateLdcPerUsd,
    markupPct: patch.markupPct !== undefined ? patch.markupPct : current.markupPct,
    cancelLockSeconds:
      patch.cancelLockSeconds !== undefined ? Math.floor(patch.cancelLockSeconds) : current.cancelLockSeconds,
    cancelRetrySeconds:
      patch.cancelRetrySeconds !== undefined ? Math.floor(patch.cancelRetrySeconds) : current.cancelRetrySeconds,
    safetyBufferUsd:
      patch.safetyBufferUsd !== undefined ? dec(patch.safetyBufferUsd) : current.safetyBufferUsd,
    autoCancelMinutes:
      patch.autoCancelMinutes !== undefined ? Math.floor(patch.autoCancelMinutes) : current.autoCancelMinutes,
    faceValuePresets: patch.faceValuePresets !== undefined ? [...patch.faceValuePresets] : current.faceValuePresets,
  };

  // 只写「显式传进来」的键，避免把环境变量兜底值固化进库
  /* 只写「显式传进来」的键：由 SETTING_KEYS + 映射表推导，不再手抄列表 */
  const touched = SETTING_KEYS.filter((key) => patch[KEY_TO_FIELD[key]] !== undefined);

  for (const key of touched) {
    const value = serialize(key, merged);
    // 非法值拒绝入库（校验与 parseDbValue 保持一致）
    if (Object.keys(parseDbValue(key, value, envBase)).length === 0) continue;
    await getPrisma().setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  resetSettingsCache();
  return getSiteSettings();
}
