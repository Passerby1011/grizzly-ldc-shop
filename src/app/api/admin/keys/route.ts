import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { jsonOk, readJsonBody, withRoute, getSearchParams } from "@/lib/http";
import { dec } from "@/lib/money";
import { issueCardKeys, MAX_KEYS_PER_BATCH, type PoolState } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  faceUsd: z.union([z.number(), z.string()]),
  count: z.coerce.number().int().min(1).max(MAX_KEYS_PER_BATCH),
  note: z.string().max(200).optional(),
});

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

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
  requireAdmin(request);
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

/** 卡密列表（分页，不含明文）。 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  const params = getSearchParams(request);

  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = Math.min(
    Math.max(Number(params.get("pageSize") ?? PAGE_SIZE_DEFAULT) || PAGE_SIZE_DEFAULT, 1),
    PAGE_SIZE_MAX,
  );
  const status = params.get("status") || undefined;
  const search = (params.get("q") || "").trim();

  const where = {
    ...(status ? { status } : {}),
    ...(search ? { codePrefix: { contains: search, mode: "insensitive" as const } } : {}),
  };

  const prisma = getPrisma();
  const [total, keys] = await Promise.all([
    prisma.cardKey.count({ where }),
    prisma.cardKey.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { order: { select: { outTradeNo: true } } },
    }),
  ]);

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
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
