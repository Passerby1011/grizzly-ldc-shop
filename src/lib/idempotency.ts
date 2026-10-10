/**
 * 幂等键读写 + 内存锁 + 可选 Upstash 锁。
 *
 * - `claimIdempotencyKey`：靠主键唯一约束抢占，抢不到就是重复请求。
 * - `withLock`：同进程用内存锁；配置了 Upstash 时改用 Redis `SET NX PX`，
 *   多实例部署下也能互斥。
 */
import { Redis } from "@upstash/redis";
import { getPrisma } from "./db";
import { tryGetConfig } from "./config";

export class LockBusyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`操作正在进行中，请稍后重试: ${key}`);
    this.name = "LockBusyError";
    this.key = key;
  }
}

export interface LockProvider {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
  readonly kind: "memory" | "redis";
}

interface LockRecord {
  token: string;
  expiresAt: number;
}

const globalForLocks = globalThis as unknown as { __grizzlyLocks?: Map<string, LockRecord> };

function lockMap(): Map<string, LockRecord> {
  if (!globalForLocks.__grizzlyLocks) globalForLocks.__grizzlyLocks = new Map();
  return globalForLocks.__grizzlyLocks;
}

/** 进程内锁。单实例部署够用；多实例请配 Upstash。 */
export function createMemoryLock(): LockProvider {
  return {
    kind: "memory",
    async acquire(key, ttlMs) {
      const map = lockMap();
      const now = Date.now();
      const existing = map.get(key);
      if (existing && existing.expiresAt > now) return false;
      map.set(key, { token: `${now}-${Math.random()}`, expiresAt: now + ttlMs });
      return true;
    },
    async release(key) {
      lockMap().delete(key);
    },
  };
}

/** Upstash Redis 锁（`SET key token NX PX ttl`）。 */
export function createUpstashLock(url: string, token: string, prefix = "glc:lock:"): LockProvider {
  const redis = new Redis({ url, token });
  return {
    kind: "redis",
    async acquire(key, ttlMs) {
      const result = await redis.set(`${prefix}${key}`, "1", { nx: true, px: Math.max(1000, ttlMs) });
      return result === "OK";
    },
    async release(key) {
      await redis.del(`${prefix}${key}`);
    },
  };
}

let cachedLock: LockProvider | null = null;

/** 有 Upstash 就用 Redis 锁，否则退化为内存锁。 */
export function getDefaultLock(): LockProvider {
  if (cachedLock) return cachedLock;
  const config = tryGetConfig();
  cachedLock =
    config && config.redisEnabled
      ? createUpstashLock(config.UPSTASH_REDIS_REST_URL, config.UPSTASH_REDIS_REST_TOKEN)
      : createMemoryLock();
  return cachedLock;
}

export function resetLockCache(): void {
  cachedLock = null;
}

/** 抢锁执行；抢不到抛 LockBusyError。 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; lock?: LockProvider } = {},
): Promise<T> {
  const lock = options.lock ?? getDefaultLock();
  const ttlMs = options.ttlMs ?? 30_000;
  const acquired = await lock.acquire(key, ttlMs);
  if (!acquired) throw new LockBusyError(key);
  try {
    return await fn();
  } finally {
    await lock.release(key);
  }
}

/** 抢锁执行；抢不到返回 null（用于「已有同名操作在跑，直接跳过」）。 */
export async function tryWithLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttlMs?: number; lock?: LockProvider } = {},
): Promise<T | null> {
  try {
    return await withLock(key, fn, options);
  } catch (error) {
    if (error instanceof LockBusyError) return null;
    throw error;
  }
}

export interface IdempotencyStore {
  claim(key: string, scope: string): Promise<boolean>;
}

/** Prisma 实现：靠主键唯一约束抢占。 */
export function createPrismaIdempotencyStore(): IdempotencyStore {
  return {
    async claim(key, scope) {
      try {
        await getPrisma().idempotencyKey.create({ data: { key, scope } });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

let cachedStore: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!cachedStore) cachedStore = createPrismaIdempotencyStore();
  return cachedStore;
}

/**
 * 抢占幂等键。返回 true 表示「第一次」，false 表示「重复请求」。
 * 注意：只有在动作成功后才应该保留键；失败时调用 `releaseIdempotencyKey` 放行重试。
 */
export async function claimIdempotencyKey(
  key: string,
  scope: string,
  store: IdempotencyStore = getIdempotencyStore(),
): Promise<boolean> {
  return store.claim(key, scope);
}

/** 释放幂等键（动作失败时允许上游重试）。 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  try {
    await getPrisma().idempotencyKey.delete({ where: { key } });
  } catch {
    // 不存在即已是释放状态
  }
}

/** 幂等执行包装：重复请求直接返回 null。 */
export async function runIdempotent<T>(
  key: string,
  scope: string,
  fn: () => Promise<T>,
): Promise<{ executed: boolean; value: T | null }> {
  const claimed = await claimIdempotencyKey(key, scope);
  if (!claimed) return { executed: false, value: null };
  try {
    const value = await fn();
    return { executed: true, value };
  } catch (error) {
    await releaseIdempotencyKey(key);
    throw error;
  }
}
