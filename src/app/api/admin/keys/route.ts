import { z } from "zod";
import {
  jsonOk,
  readJsonBody,
  requireBearer,
  withRoute,
  getSearchParams,
} from "@/lib/http";
import { getConfig } from "@/lib/config";
import { getPrisma } from "@/lib/db";
import { dec } from "@/lib/money";
import { issueCardKeys, MAX_KEYS_PER_BATCH, type PoolState } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  faceUsd: z.union([z.number(), z.string()]),
  count: z.coerce.number().int().min(1).max(MAX_KEYS_PER_BATCH),
  note: z.string().max(200).optional(),
});

function serializePool(pool: PoolState) {
  return {
    realBalanceUsd: pool.realBalanceUsd.toFixed(2),
    allocatedUsd: pool.allocatedUsd.toFixed(2),
    safetyBufferUsd: pool.safetyBufferUsd.toFixed(2),
    availableUsd: pool.availableUsd.toFixed(2),
    source: pool.source,
    degraded: pool.degraded,
  };
}

/** 生成卡密：先校验可用池，不足返回 409；明文只在这里返回一次。 */
export const POST = withRoute(async (request: Request) => {
  requireBearer(request, getConfig().ADMIN_TOKEN, "管理口令错误");
  const body = await readJsonBody(request, BodySchema);
  const result = await issueCardKeys({
    faceUsd: body.faceUsd,
    count: body.count,
    note: body.note ?? null,
  });
  return jsonOk({
    keys: result.keys,
    totalFaceUsd: result.totalFaceUsd,
    pool: serializePool(result.pool),
    notice: "明文只展示这一次，请立刻保存；库里只有 SHA-256。",
  });
});

/** 卡密列表（不含明文）。 */
export const GET = withRoute(async (request: Request) => {
  requireBearer(request, getConfig().ADMIN_TOKEN, "管理口令错误");
  const params = getSearchParams(request);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50) || 50, 1), 200);
  const status = params.get("status");

  const keys = await getPrisma().cardKey.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { order: { select: { outTradeNo: true } } },
  });

  return jsonOk({
    keys: keys.map((key) => ({
      id: key.id,
      codePrefix: key.codePrefix,
      faceUsd: dec(key.faceUsd.toString()).toFixed(2),
      balanceUsd: dec(key.balanceUsd.toString()).toFixed(2),
      status: key.status,
      note: key.note,
      outTradeNo: key.order?.outTradeNo ?? null,
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    })),
    count: keys.length,
  });
});
