import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { badRequest, conflict, jsonOk, notFound, readJsonBody, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  id: z.string().min(1),
  action: z.enum(["revoke", "restore"]),
});

/**
 * 卡密作废 / 恢复。
 *
 * 作废为什么能"释放池额度"：池的已分配金额只统计 `status = 'active'` 的卡密
 * （见 pool.ts 的 getAllocatedUsd），所以把状态改成 revoked，
 * 该卡密剩余余额就自动退出占用，相应的 PoolReservation 标记 released 作为凭据。
 *
 * 恢复必须重新校验池容量，否则反复 revoke/restore 可以把池子刷成超卖。
 */
export const POST = withRoute(async (request: Request) => {
  requireAdmin(request);
  const body = await readJsonBody(request, BodySchema);
  const prisma = getPrisma();

  const key = await prisma.cardKey.findUnique({
    where: { id: body.id },
    include: { order: { select: { outTradeNo: true } } },
  });
  if (!key) throw notFound("卡密不存在");

  const balance = dec(key.balanceUsd.toString());

  if (body.action === "revoke") {
    if (key.status === "revoked") throw conflict("CONFLICT", "该卡密已经是作废状态");
    if (key.status === "depleted" && balance.isZero() === false) {
      throw badRequest("余额与状态不一致，请先对账再操作");
    }

    await prisma.$transaction(async (tx) => {
      await tx.cardKey.update({ where: { id: key.id }, data: { status: "revoked" } });
      await tx.poolReservation.updateMany({
        where: { keyId: key.id, released: false },
        data: { released: true, releasedAt: new Date() },
      });
    });

    return jsonOk({
      id: key.id,
      codePrefix: key.codePrefix,
      status: "revoked",
      releasedUsd: balance.toFixed(2),
      notice: "该卡密剩余余额已退出池占用；恢复时会重新校验池容量。",
    });
  }

  // restore
  if (key.status !== "revoked") throw conflict("CONFLICT", "只有已作废的卡密才能恢复");

  const { assertPoolCapacity } = await import("@/lib/pool");
  await assertPoolCapacity(balance.toFixed(2));

  await prisma.$transaction(async (tx) => {
    await tx.cardKey.update({
      where: { id: key.id },
      data: { status: balance.isZero() ? "depleted" : "active" },
    });
    await tx.poolReservation.updateMany({
      where: { keyId: key.id },
      data: { released: false, releasedAt: null },
    });
  });

  return jsonOk({
    id: key.id,
    codePrefix: key.codePrefix,
    status: balance.isZero() ? "depleted" : "active",
    reoccupiedUsd: balance.toFixed(2),
  });
});
