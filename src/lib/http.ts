/**
 * 统一 JSON 响应、错误码、请求体校验辅助 + 会话 Cookie 读写。
 *
 * 响应约定：
 *   成功 `{ ok: true, data: T }`
 *   失败 `{ ok: false, error: { code, message, details? } }`
 * 例外：LDC 异步通知必须返回纯文本 `success`，由路由自己构造。
 */
import { z, type ZodTypeAny } from "zod";
import { ConfigError, tryGetConfig } from "./config";
import { KeyNotFoundError, InsufficientBalanceError } from "./ledger";
import { PoolExhaustedError } from "./pool";
import { GrizzlyApiError, GrizzlyTransportError, type GrizzlyErrorCode } from "./grizzly";
import { LdcApiError } from "./ldc";
import { LockBusyError } from "./idempotency";
import { constantTimeEqual, signSessionToken, verifySessionToken } from "./keycodec";

export const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  POOL_EXHAUSTED: "POOL_EXHAUSTED",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  LOCK_BUSY: "LOCK_BUSY",
  CONFIG_ERROR: "CONFIG_ERROR",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(ERROR_CODES.BAD_REQUEST, message, 400, details);
}

export function unauthorized(message = "未授权", details?: unknown): ApiError {
  return new ApiError(ERROR_CODES.UNAUTHORIZED, message, 401, details);
}

export function forbidden(message = "禁止访问", details?: unknown): ApiError {
  return new ApiError(ERROR_CODES.FORBIDDEN, message, 403, details);
}

export function notFound(message = "资源不存在", details?: unknown): ApiError {
  return new ApiError(ERROR_CODES.NOT_FOUND, message, 404, details);
}

export function conflict(code: ErrorCode, message: string, details?: unknown): ApiError {
  return new ApiError(code, message, 409, details);
}

export interface JsonResponseInit {
  status?: number;
  headers?: HeadersInit;
}

export function jsonOk<T>(data: T, init: JsonResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...toHeaderObject(init.headers) },
  });
}

export function jsonError(
  code: ErrorCode,
  message: string,
  status: number,
  details?: unknown,
  init: JsonResponseInit = {},
): Response {
  const body: Record<string, unknown> = { ok: false, error: { code, message } };
  if (details !== undefined) (body.error as Record<string, unknown>).details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...toHeaderObject(init.headers) },
  });
}

function toHeaderObject(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

/** 把任意异常映射成统一错误响应。 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonError(error.code, error.message, error.status, error.details);
  }
  if (error instanceof ConfigError) {
    return jsonError(ERROR_CODES.CONFIG_ERROR, error.message, 500);
  }
  if (error instanceof InsufficientBalanceError) {
    return jsonError(ERROR_CODES.INSUFFICIENT_BALANCE, error.message, 402, {
      requiredUsd: error.amountUsd.toFixed(2),
    });
  }
  if (error instanceof KeyNotFoundError) {
    return jsonError(ERROR_CODES.NOT_FOUND, error.message, 404);
  }
  if (error instanceof PoolExhaustedError) {
    return jsonError(ERROR_CODES.POOL_EXHAUSTED, error.message, 409, {
      requiredUsd: error.requiredUsd.toFixed(2),
      availableUsd: error.availableUsd.toFixed(2),
      shortfallUsd: error.shortfallUsd.toFixed(2),
    });
  }
  if (error instanceof LockBusyError) {
    return jsonError(ERROR_CODES.LOCK_BUSY, error.message, 409);
  }
  if (error instanceof GrizzlyApiError) {
    return jsonError(ERROR_CODES.UPSTREAM_ERROR, grizzlyMessageZh(error), 502, {
      upstream: "grizzly",
      code: error.code,
      upstreamRaw: error.raw.slice(0, 200),
    });
  }
  if (error instanceof GrizzlyTransportError) {
    return jsonError(ERROR_CODES.UPSTREAM_ERROR, `上游不可达：${error.message}`, 502, {
      upstream: "grizzly",
      status: error.status,
    });
  }
  if (error instanceof LdcApiError) {
    return jsonError(ERROR_CODES.UPSTREAM_ERROR, error.message, 502, {
      upstream: "ldc",
      status: error.status,
    });
  }
  if (error instanceof z.ZodError) {
    return jsonError(ERROR_CODES.BAD_REQUEST, "参数校验失败", 400, error.issues);
  }
  if (error instanceof RangeError) {
    return jsonError(ERROR_CODES.BAD_REQUEST, error.message, 400);
  }
  console.error("[api] 未处理异常", error);
  const message = error instanceof Error ? error.message : "服务器内部错误";
  return jsonError(ERROR_CODES.INTERNAL, message, 500);
}

/** Grizzly 错误码 → 中文可读文案；未映射的码走通用兜底，绝不把 `UNKNOWN` 字面量抛给用户。 */
const GRIZZLY_MESSAGE_ZH: Partial<Record<GrizzlyErrorCode, string>> = {
  EARLY_CANCEL_DENIED: "取号后短时间内上游不允许取消，请稍后再试",
  NO_ACTIVATION: "该号码已结束（收到验证码、被取消或已超时退款）",
  NO_NUMBERS: "当前国家/服务暂时没有可用号码，请换个组合试试",
  NO_BALANCE: "上游主账号余额不足，请联系卖家",
  BAD_KEY: "上游密钥无效，请联系卖家",
  SERVICE_UNAVAILABLE_REGION: "上游限制了当前出口地区，请联系卖家",
  SERVICE_PROHIBITED: "该服务被上游禁止销售，请换一个",
  WRONG_MAX_PRICE: "出价低于上游成本，请重新估价",
  BAD_ACTION: "上游接口不支持该操作，请联系卖家",
  BAD_STATUS: "上游拒绝了该状态变更",
  EMPTY_RESPONSE: "上游返回了空响应，请稍后再试",
};

function grizzlyMessageZh(error: GrizzlyApiError): string {
  return GRIZZLY_MESSAGE_ZH[error.code] ?? "上游返回了未识别的响应，请稍后再试或联系卖家";
}

export type RouteHandler = (request: Request) => Promise<Response>;

/** 路由包装：统一 try/catch → JSON 错误。 */
export function withRoute(handler: RouteHandler): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export function getSearchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export async function readJsonBody<T extends ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("请求体必须是合法 JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest("参数校验失败", parsed.error.issues);
  return parsed.data;
}

export function readQuery<T extends ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  const raw = Object.fromEntries(getSearchParams(request).entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest("查询参数校验失败", parsed.error.issues);
  return parsed.data;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** 校验 `Authorization: Bearer <expected>`（常量时间比较）。 */
export function requireBearer(
  request: Request,
  expected: string,
  message = "未授权",
): void {
  const token = bearerToken(request);
  if (!expected) throw new ApiError(ERROR_CODES.CONFIG_ERROR, "服务端未配置鉴权口令", 500);
  if (!token || !constantTimeEqual(token, expected)) throw unauthorized(message);
}

/* ------------------------------------------------------------------ */
/* 会话 Cookie                                                        */
/* ------------------------------------------------------------------ */

export const SESSION_COOKIE_NAME = "glc_key";
/** 卡密会话有效期：12 小时。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string {
  const config = tryGetConfig();
  if (!config) throw new ConfigError("缺少环境变量，无法签名会话");
  return config.cookieSecret;
}

function cookieAttributes(maxAgeSeconds: number): string {
  const config = tryGetConfig();
  const https = Boolean(config?.NEXT_PUBLIC_APP_URL.startsWith("https://"));
  const secure = https || process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function buildSessionCookie(keyId: string): string {
  const token = signSessionToken(keyId, SESSION_TTL_MS, sessionSecret());
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(Math.floor(SESSION_TTL_MS / 1000))}`;
}

export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

export function appendSessionCookie(headers: Headers, keyId: string): void {
  headers.append("set-cookie", buildSessionCookie(keyId));
}

export function clearSessionCookie(headers: Headers): void {
  headers.append("set-cookie", buildClearSessionCookie());
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie");
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** 读取卡密会话；没登录/被篡改/过期返回 null。 */
export function readSession(request: Request): { keyId: string } | null {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  try {
    return verifySessionToken(token, sessionSecret());
  } catch {
    return null;
  }
}

/** 需要卡密会话的路由用这个：拿不到直接 401。 */
export function requireSession(request: Request): string {
  const session = readSession(request);
  if (!session) throw unauthorized("请先贴入有效卡密");
  return session.keyId;
}
