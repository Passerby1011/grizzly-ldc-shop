import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { getSearchParams, jsonOk, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/** 订单列表（分页 + 状态筛选）。不含任何密钥。 */
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
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { key: { select: { codePrefix: true, status: true } } },
    }),
  ]);

  return jsonOk({
    orders: rows.map((o) => ({
      id: o.id,
      outTradeNo: o.outTradeNo,
      ldcTradeNo: o.ldcTradeNo,
      gateway: o.gateway,
      name: o.name,
      amountLdc: dec(o.amountLdc.toString()).toFixed(2),
      faceUsd: dec(o.faceUsd.toString()).toFixed(2),
      status: o.status,
      paidAt: o.paidAt ? o.paidAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
      keyPrefix: o.key?.codePrefix ?? null,
      keyStatus: o.key?.status ?? null,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
