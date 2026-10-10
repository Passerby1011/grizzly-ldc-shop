/**
 * PrismaClient 单例（开发环境热更新时避免连接爆炸）。
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __grizzlyPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__grizzlyPrisma) {
    globalForPrisma.__grizzlyPrisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return globalForPrisma.__grizzlyPrisma;
}

/** 事务客户端类型（$transaction 回调参数）。 */
export type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
