import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { badRequest, conflict, jsonOk, notFound, readJsonBody, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  id: z.string().min(1),
  action: z.enum(["revoke", "restore", "adjust"]),
  /** 仅 action=adjust 用：带符号的调整额（正=加，负=减），两位小数。 */
  amountUsd: z.union([z.number(), z.string()]).optional(),
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

  if (body.action === "adjust") {
    /*
     * 手动调整卡密额度（后台）。
     *
     * 为什么要走 ledger.manualAdjust 而不是直接改 balanceUsd：
     *   · 必须留流水 —— 否则余额凭空变了，事后谁也说不清钱哪来的；
     *   · 对账等式已经专门减去 reason="manual" 的合计（getManualAdjustedUsd），
     *     所以人工调整**不会**manufacture 出假差额，这是设计好的口径；
     *   · 走 ledgeder 还能顺带维护 active/depleted 状态互转。
     *
     * 加钱要过池容量闸门：加余额 = 该卡重新占用池子，不能超卖。
     */
    const raw = body.amountUsd;
    if (raw === undefined) throw badRequest("缺少调整金额");

    const { dec: decRaw } = await import("@/lib/money");
    let delta;
    try {
      delta = decRaw(raw);
    } catch {
      throw badRequest("调整金额不是合法数字");
    }
    if (delta.isZero()) throw badRequest("调整金额不能为 0");
    if (delta.abs().gt(1000)) throw badRequest("单次调整不能超过 1000 USD");
    /* 只允许两位小数，避免库里出现 0.003 这种账 */
    if (!delta.times(100).isInteger()) throw badRequest("调整金额最多保留两位小数");

    if (delta.gt(0)) {
      /* 加钱 = 多占用池子，先过容量闸门（作废卡不加占用，跳过） */
      if (key.status !== "revoked") {
        const { assertPoolCapacity } = await import("@/lib/pool");
        await assertPoolCapacity(delta.toFixed(2));
      }
    }

    const { getLedger } = await import("@/lib/ledger");
    const entry = await getLedger()
      .manualAdjust(undefined, key.id, delta.toFixed(2), `admin:${key.codePrefix}`)
      .catch((error: unknown) => {
        /* 减额超过余额 → 账本抛 InsufficientBalance，转成 400 而不是 500 */
        const message = error instanceof Error ? error.message : String(error);
        throw badRequest(message);
      });

    const after = await prisma.cardKey.findUnique({ where: { id: key.id } });

    return jsonOk({
      id: key.id,
      codePrefix: key.codePrefix,
      deltaUsd: delta.toFixed(2),
      balanceUsd: entry.balanceAfter.toFixed(2),
      status: after?.status ?? key.status,
      notice: `已调整 ${delta.gt(0) ? "+" : ""}${delta.toFixed(2)} USD，当前余额 ${entry.balanceAfter.toFixed(2)} USD（已写入 manual 流水，对账不会因此产生差额）`,
    });
  }

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
