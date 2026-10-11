import { jsonOk, withRoute } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { runReconcile, calibrateBaseline } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 对账：核对**上游真实余额**与**本地推算余额**是否一致。
 *
 *   应有余额 = 基准投入 − 净消耗 − 手工调整
 *   差额     = 真实余额 − 应有余额
 *
 * 只有「我们不知道的上游变动」（老板手动给 Grizzly 充值 / 直接在上游消费）
 * 才会产生差额。发卡、充值入账、作废卡密都是纯本地动作，不会造成差额。
 */
export const POST = withRoute(async (request: Request) => {
  requireAdmin(request);
  const result = await runReconcile();
  if (!result.ok) console.error("[reconcile] 差额告警", result.message);
  return jsonOk(result);
});

/** 校准：把当前差额并入基准，使对账归零。只改基准，不动任何卡密余额与流水。 */
export const PUT = withRoute(async (request: Request) => {
  requireAdmin(request);
  const result = await calibrateBaseline();
  return jsonOk({
    ...result,
    notice: `已把差额 ${result.driftBefore} USD 并入基准；对账现在应显示一致。`,
  });
});
