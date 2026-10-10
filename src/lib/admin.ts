/**
 * 管理员鉴权：同时支持两种方式。
 *
 * 1. `Authorization: Bearer <ADMIN_TOKEN>` —— 适合脚本 / curl；
 * 2. `glc_admin` HttpOnly Cookie —— 适合后台页面，比每次带 token 顺手。
 *
 * Cookie 值是 HMAC 签名的短令牌（复用 keycodec 的会话令牌原语），
 * 主题固定为 "admin"，与买家卡密会话（clc_key）互不通用。
 *
 * 口令比对一律走 constantTimeEqual，避免时序侧信道。
 */
import { tryGetConfig } from "./config";
import { ApiError, ERROR_CODES, SESSION_TTL_MS, bearerToken, unauthorized } from "./http";
import { constantTimeEqual, signSessionToken, verifySessionToken } from "./keycodec";

export const ADMIN_COOKIE_NAME = "glc_admin";
/** 后台会话有效期：12 小时，与买家会话一致。 */
export const ADMIN_SESSION_TTL_MS = SESSION_TTL_MS;

const ADMIN_SUBJECT = "admin";

/* ------------------------------------------------------------------ */
/* 口令与签名                                                          */
/* ------------------------------------------------------------------ */

export class AdminConfigError extends ApiError {
  constructor(message = "服务端未配置管理口令（ADMIN_TOKEN）") {
    super(ERROR_CODES.CONFIG_ERROR, message, 500);
    this.name = "AdminConfigError";
  }
}

function expectedToken(): string {
  const config = tryGetConfig();
  if (!config || !config.ADMIN_TOKEN) throw new AdminConfigError();
  return config.ADMIN_TOKEN;
}

function adminSecret(): string {
  const config = tryGetConfig();
  if (!config) throw new AdminConfigError();
  return `${config.cookieSecret}/admin/v1`;
}

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

function cookieAttributes(maxAgeSeconds: number): string {
  const config = tryGetConfig();
  const https = Boolean(config?.NEXT_PUBLIC_APP_URL.startsWith("https://"));
  const secure = https || process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function buildAdminCookie(): string {
  const token = signSessionToken(ADMIN_SUBJECT, ADMIN_SESSION_TTL_MS, adminSecret());
  return `${ADMIN_COOKIE_NAME}=${token}; ${cookieAttributes(Math.floor(ADMIN_SESSION_TTL_MS / 1000))}`;
}

export function buildClearAdminCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; ${cookieAttributes(0)}`;
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
    if (name) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

/** Cookie 会话是否有效（不抛错版本，供页面渲染判断）。 */
export function isAdminAuthed(request: Request): boolean {
  try {
    return readCookieSession(request);
  } catch {
    return false;
  }
}

function readCookieSession(request: Request): boolean {
  const token = parseCookies(request)[ADMIN_COOKIE_NAME];
  if (!token) return false;
  const payload = verifySessionToken(token, adminSecret());
  return Boolean(payload && payload.keyId === ADMIN_SUBJECT);
}

/* ------------------------------------------------------------------ */
/* 鉴权入口                                                            */
/* ------------------------------------------------------------------ */

/** 校验管理口令：Bearer 或 Cookie 任一通过即可，否则 401。 */
export function requireAdmin(request: Request): void {
  const expected = expectedToken();

  const bearer = bearerToken(request);
  if (bearer && constantTimeEqual(bearer, expected)) return;

  if (readCookieSession(request)) return;

  throw unauthorized("管理口令错误");
}

/** 校验明文口令是否正确（登录用）。 */
export function verifyAdminToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return constantTimeEqual(candidate, expectedToken());
}

/* ------------------------------------------------------------------ */
/* 登录限速（进程内，够单区域用；多实例时配合 Upstash 更强）             */
/* ------------------------------------------------------------------ */

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

/** 取客户端 IP：Vercel 会带 x-forwarded-for，取第一段。 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 超过阈值直接 429。 */
export function assertLoginRateLimit(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new ApiError(
      ERROR_CODES.LOCK_BUSY,
      `尝试过于频繁，请 ${retryAfterSeconds} 秒后再试`,
      429,
      { retryAfterSeconds },
    );
  }
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

/** 仅供测试。 */
export function resetAdminRateLimit(): void {
  attempts.clear();
}
