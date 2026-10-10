/**
 * 卡密生成 / 解析 / 哈希。
 *
 * 格式：GS-XXXX-XXXX-XXXX-XXXX（4 组 × 4 位 = 16 位，Crockford base32 字母表，
 * 去掉易混淆的 I / L / O / U），共 80 bit 熵。
 * 明文只展示一次，库里只存 SHA-256。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Crockford base32：0-9 + 去掉 I L O U 的 22 个字母。 */
export const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const KEY_PREFIX = "GS";
export const KEY_GROUP_SIZE = 4;
export const KEY_GROUPS = 4;
export const KEY_BODY_LENGTH = KEY_GROUP_SIZE * KEY_GROUPS;

const DECODE_MAP: Record<string, string> = {
  I: "1",
  L: "1",
  O: "0",
};

function symbolAt(index: number): string {
  return KEY_ALPHABET[index] ?? KEY_ALPHABET[0];
}

/** 生成 16 位随机 body（每字符 5 bit，无取模偏置）。 */
export function generateKeyBody(): string {
  const bytes = randomBytes((KEY_BODY_LENGTH * 5) / 8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = KEY_BODY_LENGTH - 1; i >= 0; i -= 1) {
    out += symbolAt(Number((bits >> BigInt(i * 5)) & 31n));
  }
  return out;
}

export function formatCode(body: string): string {
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += KEY_GROUP_SIZE) {
    groups.push(body.slice(i, i + KEY_GROUP_SIZE));
  }
  return `${KEY_PREFIX}-${groups.join("-")}`;
}

/** 生成一个新的卡密明文。 */
export function generateCode(): string {
  return formatCode(generateKeyBody());
}

/**
 * 归一化用户输入：去分隔符、转大写、Crockford 易混字符回填。
 * 合法返回 `GS-XXXX-XXXX-XXXX-XXXX`，非法返回 null。
 */
export function normalizeCode(input: string): string | null {
  if (typeof input !== "string") return null;
  const stripped = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .split("")
    .map((char) => DECODE_MAP[char] ?? char)
    .join("");
  const body = stripped.startsWith(KEY_PREFIX) ? stripped.slice(KEY_PREFIX.length) : stripped;
  if (body.length !== KEY_BODY_LENGTH) return null;
  for (const char of body) {
    if (!KEY_ALPHABET.includes(char)) return null;
  }
  return formatCode(body);
}

export function parseCode(input: string): { code: string; body: string } | null {
  const code = normalizeCode(input);
  if (!code) return null;
  const body = code.split("-").slice(1).join("");
  return { code, body };
}

export function isValidCode(input: string): boolean {
  return normalizeCode(input) !== null;
}

/** 卡密哈希（SHA-256 十六进制，小写）。只存哈希，明文不落库。 */
export function hashCode(code: string): string {
  const parsed = normalizeCode(code);
  if (!parsed) throw new RangeError("卡密格式非法，无法哈希");
  return createHash("sha256").update(parsed).digest("hex");
}

/** 展示用前缀：`GS-ABCD`。 */
export function codePrefix(code: string): string {
  const parsed = parseCode(code);
  if (!parsed) return KEY_PREFIX;
  return `${KEY_PREFIX}-${parsed.body.slice(0, KEY_GROUP_SIZE)}`;
}

/** 掩码展示：保留首组与末 2 位。 */
export function maskCode(code: string): string {
  const parsed = parseCode(code);
  if (!parsed) return `${KEY_PREFIX}-****-****-****-****`;
  const { body } = parsed;
  return `${KEY_PREFIX}-${body.slice(0, 4)}-****-****-**${body.slice(14)}`;
}

/** 常量时间字符串比较。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * 会话令牌：`base64url(payload).base64url(hmacSha256(payload))`。
 * payload = { k: keyId, e: 过期时间戳(ms) }。
 */
export function signSessionToken(keyId: string, ttlMs: number, secret: string): string {
  const payload = base64url(JSON.stringify({ k: keyId, e: Date.now() + ttlMs }));
  const sig = base64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
): { keyId: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = base64url(createHmac("sha256", secret).update(payload).digest());
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      k?: unknown;
      e?: unknown;
    };
    if (typeof decoded.k !== "string" || typeof decoded.e !== "number") return null;
    if (decoded.e <= Date.now()) return null;
    return { keyId: decoded.k };
  } catch {
    return null;
  }
}
