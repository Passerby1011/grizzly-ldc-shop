import { jsonOk, requireSession, withRoute } from "@/lib/http";
import { getPrisma } from "@/lib/db";
import { dec } from "@/lib/money";
import { canLogin, isKeyUsable } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前卡密的余额、激活列表与最近流水。 */
export const GET = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const prisma = getPrisma();

  const [key, activations, ledger] = await Promise.all([
    prisma.cardKey.findUnique({ where: { id: keyId } }),
    prisma.activation.findMany({ where: { keyId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.keyLedger.findMany({ where: { keyId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  return jsonOk({
    key: key
      ? {
          id: key.id,
          codePrefix: key.codePrefix,
          faceUsd: dec(key.faceUsd.toString()).toFixed(2),
          balanceUsd: dec(key.balanceUsd.toString()).toFixed(2),
          status: key.status,
          expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
          /* 能否取号：前端据此决定"恢复进行中的取号"是否安全 */
          usable: isKeyUsable(key),
          /* 能否登录（depleted 也可以）：前端据此显示"余额已用完，请充值"而不是赶人 */
          loginable: canLogin(key),
          /* 余额是否为 0 —— 前端提示"充值后可继续取号" */
          depleted: dec(key.balanceUsd.toString()).isZero(),
        }
      : null,
    activations: activations.map((item) => ({
      id: item.id,
      grizzlyId: item.grizzlyId,
      service: item.service,
      country: item.country,
      phone: item.phone,
      status: item.status,
      code: item.code,
      reservedUsd: dec(item.reservedUsd.toString()).toFixed(2),
      costUsd: item.costUsd ? dec(item.costUsd.toString()).toFixed(2) : null,
      createdAt: item.createdAt.toISOString(),
      closedAt: item.closedAt ? item.closedAt.toISOString() : null,
    })),
    ledger: ledger.map((item) => ({
      id: item.id,
      deltaUsd: dec(item.deltaUsd.toString()).toFixed(4),
      balanceAfter: dec(item.balanceAfter.toString()).toFixed(4),
      reason: item.reason,
      refId: item.refId,
      createdAt: item.createdAt.toISOString(),
    })),
  });
});
