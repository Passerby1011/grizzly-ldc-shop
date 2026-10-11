import { jsonOk, withRoute } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { dec, formatUsd } from "@/lib/money";
import { getConsumedUsd, getNetConsumedUsd, getManualAdjustedUsd, getPoolState } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 余额 / 已售未消耗 / 可用池 / 订单与激活统计。 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  const prisma = getPrisma();

  const [pool, consumed, netConsumed, manualAdjusted, keyGroups, orderGroups, activationGroups, paidOrders, recentOrders, recentActivations, lastRun, lastSnapshot] =
    await Promise.all([
      getPoolState(),
      getConsumedUsd(prisma),
      getNetConsumedUsd(prisma),
      getManualAdjustedUsd(prisma),
      prisma.cardKey.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.activation.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.order.aggregate({
        _sum: { amountLdc: true, faceUsd: true },
        where: { status: "paid" },
      }),
      prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.activation.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.reconcileRun.findFirst({ orderBy: { createdAt: "desc" } }),
      prisma.grizzlySnapshot.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);

  const keyCounts = Object.fromEntries(keyGroups.map((g) => [g.status, g._count._all]));
  const orderCounts = Object.fromEntries(orderGroups.map((g) => [g.status, g._count._all]));
  const activationCounts = Object.fromEntries(activationGroups.map((g) => [g.status, g._count._all]));

  return jsonOk({
    pool: {
      realBalanceUsd: pool.realBalanceUsd.toFixed(2),
      allocatedUsd: pool.allocatedUsd.toFixed(2),
      safetyBufferUsd: pool.safetyBufferUsd.toFixed(2),
      availableUsd: pool.availableUsd.toFixed(2),
      source: pool.source,
      degraded: pool.degraded,
      observedAt: pool.observedAt ? pool.observedAt.toISOString() : null,
    },
    ledger: {
      /** 所有负向流水之和：用户累计花掉多少（含手工扣款）。 */
      consumedUsd: formatUsd(consumed),
      /** 净消耗：真正打到上游且没退回的部分 —— 对账等式用的就是它。 */
      netConsumedUsd: formatUsd(netConsumed),
      /** 手工调整净额（正=给用户加钱）。 */
      manualAdjustedUsd: formatUsd(manualAdjusted),
    },
    cards: {
      byStatus: keyCounts,
      total: Object.values(keyCounts).reduce((sum, value) => sum + value, 0),
    },
    orders: {
      byStatus: orderCounts,
      total: Object.values(orderCounts).reduce((sum, value) => sum + value, 0),
      paidAmountLdc: formatUsd(paidOrders._sum.amountLdc?.toString() ?? 0),
      paidFaceUsd: formatUsd(paidOrders._sum.faceUsd?.toString() ?? 0),
    },
    activations: {
      byStatus: activationCounts,
      total: Object.values(activationCounts).reduce((sum, value) => sum + value, 0),
    },
    lastReconcile: lastRun
      ? {
          ok: lastRun.ok,
          realUsd: formatUsd(lastRun.realUsd.toString()),
          ledgerUsd: formatUsd(lastRun.ledgerUsd.toString()),
          driftUsd: formatUsd(lastRun.driftUsd.toString()),
          message: lastRun.message,
          createdAt: lastRun.createdAt.toISOString(),
        }
      : null,
    lastSnapshot: lastSnapshot
      ? {
          realBalanceUsd: formatUsd(lastSnapshot.realBalanceUsd.toString()),
          allocatedUsd: formatUsd(lastSnapshot.allocatedUsd.toString()),
          availableUsd: formatUsd(lastSnapshot.availableUsd.toString()),
          activeCount: lastSnapshot.activeCount,
          createdAt: lastSnapshot.createdAt.toISOString(),
        }
      : null,
    recentOrders: recentOrders.map((order) => ({
      id: order.id,
      outTradeNo: order.outTradeNo,
      name: order.name,
      status: order.status,
      faceUsd: dec(order.faceUsd.toString()).toFixed(2),
      amountLdc: dec(order.amountLdc.toString()).toFixed(2),
      keyId: order.keyId,
      paidAt: order.paidAt ? order.paidAt.toISOString() : null,
      createdAt: order.createdAt.toISOString(),
    })),
    recentActivations: recentActivations.map((item) => ({
      id: item.id,
      grizzlyId: item.grizzlyId,
      service: item.service,
      country: item.country,
      phone: item.phone,
      status: item.status,
      code: item.code,
      costUsd: item.costUsd ? dec(item.costUsd.toString()).toFixed(2) : null,
      createdAt: item.createdAt.toISOString(),
    })),
  });
});
