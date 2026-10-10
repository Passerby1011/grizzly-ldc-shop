import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { getSearchParams, jsonOk, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

/** 卡密余额流水（分页，可按 keyId 过滤）。这是钱怎么花的唯一凭据。 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  const params = getSearchParams(request);

  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = Math.min(
    Math.max(Number(params.get("pageSize") ?? PAGE_SIZE_DEFAULT) || PAGE_SIZE_DEFAULT, 1),
    PAGE_SIZE_MAX,
  );
  const keyId = (params.get("keyId") || "").trim() || undefined;
  const reason = (params.get("reason") || "").trim() || undefined;

  const where = {
    ...(keyId ? { keyId } : {}),
    ...(reason ? { reason } : {}),
  };
  const prisma = getPrisma();

  const [total, rows] = await Promise.all([
    prisma.keyLedger.count({ where }),
    prisma.keyLedger.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { key: { select: { codePrefix: true } } },
    }),
  ]);

  return jsonOk({
    entries: rows.map((e) => ({
      id: e.id,
      keyId: e.keyId,
      keyPrefix: e.key?.codePrefix ?? null,
      deltaUsd: dec(e.deltaUsd.toString()).toFixed(2),
      balanceAfter: dec(e.balanceAfter.toString()).toFixed(2),
      reason: e.reason,
      refId: e.refId,
      createdAt: e.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
