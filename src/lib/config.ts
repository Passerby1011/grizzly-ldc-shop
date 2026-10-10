/**
 * 环境变量读取 + 校验（zod）。单例，惰性求值。
 *
 * 注意：不要在模块顶层调用 getConfig()——Next.js 构建期会 import 模块，
 * 缺失环境变量时应该只在「真正发请求」时才抛错。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/** 首页套餐面值（美元）。 */
export const FACE_VALUE_PRESETS = [1, 3, 5, 10] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const nonEmptyString = z.string().min(1, "不能为空");

const absoluteUrl = z
  .string()
  .min(1, "不能为空")
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "必须是 http(s) 绝对 URL" },
  );

function numberFromEnv(defaultValue: number, min?: number, max?: number) {
  let schema = z.coerce.number();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess(
    (value) => (value === undefined || value === null || value === "" ? defaultValue : value),
    schema,
  );
}

const EnvSchema = z.object({
  // Grizzly SMS
  GRIZZLY_API_KEY: nonEmptyString,
  GRIZZLY_API_BASE: absoluteUrl.default("https://api.grizzlysms.com/stubs/handler_api.php"),

  // LINUX DO Credit（易支付兼容协议）
  LDC_PID: nonEmptyString,
  LDC_KEY: nonEmptyString,
  LDC_API_BASE: absoluteUrl.default("https://credit.linux.do/epay"),
  LDC_PRIVATE_KEY_B64: z.string().default(""),

  // 数据与缓存
  DATABASE_URL: nonEmptyString,
  UPSTASH_REDIS_REST_URL: z.string().default(""),
  UPSTASH_REDIS_REST_TOKEN: z.string().default(""),

  // 站点参数
  ADMIN_TOKEN: z.string().min(8, "至少 8 位"),
  RATE_LDC_PER_USD: numberFromEnv(1.1, 0.000001),
  MARKUP_PCT: numberFromEnv(0, 0, 10000),
  SAFETY_BUFFER_USD: numberFromEnv(0.5, 0),
  // 取号后可取消的最短等待秒数（实测 Grizzly 约 60s 拒绝 EARLY_CANCEL_DENIED）
  CANCEL_LOCK_SECONDS: numberFromEnv(90, 0),
  NEXT_PUBLIC_APP_URL: absoluteUrl.default("http://localhost:3000"),

  // 对账 Cron
  CRON_SECRET: z.string().default(""),
});

export type EnvInput = Record<string, string | undefined>;

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** Cookie / 会话签名密钥（由 LDC_KEY 派生，无需新增环境变量）。 */
  readonly cookieSecret: string;
  /** LDC 异步通知地址。 */
  readonly notifyUrl: string;
  /** Upstash 是否配置齐全。 */
  readonly redisEnabled: boolean;
  /** 首页套餐面值。 */
  readonly presets: readonly number[];
};

export function createConfig(env: EnvInput = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`环境变量校验失败 → ${issues}`);
  }
  const data = parsed.data;
  const base = data.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return {
    ...data,
    cookieSecret: createHash("sha256")
      .update(`grizzly-ldc-shop/cookie/v1:${data.LDC_KEY}`)
      .digest("hex"),
    notifyUrl: `${base}/api/pay/notify`,
    redisEnabled: Boolean(data.UPSTASH_REDIS_REST_URL && data.UPSTASH_REDIS_REST_TOKEN),
    presets: FACE_VALUE_PRESETS,
  };
}

let cached: AppConfig | null = null;

/** 进程内单例配置。缺失/非法时抛 ConfigError。 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  cached = createConfig(process.env);
  return cached;
}

/** 不抛错的版本，用于「配置缺失时降级」的场景。 */
export function tryGetConfig(): AppConfig | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

/** 仅供测试使用。 */
export function resetConfigCache(): void {
  cached = null;
}
