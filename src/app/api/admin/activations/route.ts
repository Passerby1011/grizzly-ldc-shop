import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { getSearchParams, jsonOk, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/** 激活记录（分页 + 状态筛选）：能看到每笔真实的预扣与实扣成本。 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  const params = getSearchParams(request);

  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const pageSize = Math.min(
    Math.max(Number(params.get("pageSize") ?? PAGE_SIZE_DEFAULT) || PAGE_SIZE_DEFAULT, 1),
    PAGE_SIZE_MAX,
  );
  const status = params.get("status") || undefined;

  const where = status ? { status } : {};
  const prisma = getPrisma();

  const [total, rows] = await Promise.all([
    prisma.activation.count({ where }),
    prisma.activation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { key: { select: { codePrefix: true } } },
    }),
  ]);

  return jsonOk({
    activations: rows.map((a) => ({
      id: a.id,
      keyPrefix: a.key?.codePrefix ?? null,
      grizzlyId: a.grizzlyId,
      service: a.service,
      country: a.country,
      phone: a.phone,
      reservedUsd: dec(a.reservedUsd.toString()).toFixed(2),
      costUsd: a.costUsd ? dec(a.costUsd.toString()).toFixed(2) : null,
      status: a.status,
      hasCode: Boolean(a.code),
      createdAt: a.createdAt.toISOString(),
      closedAt: a.closedAt ? a.closedAt.toISOString() : null,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
