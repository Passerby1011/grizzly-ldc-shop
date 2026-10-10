import { jsonOk, requireBearer, withRoute } from "@/lib/http";
import { getConfig } from "@/lib/config";
import { runReconcile } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel Cron 入口：`Authorization: Bearer CRON_SECRET`。
 * 对账 + 快照 + 漂移告警。
 */
export const GET = withRoute(async (request: Request) => {
  const config = getConfig();
  requireBearer(request, config.CRON_SECRET, "Cron 鉴权失败");
  const result = await runReconcile();
  if (!result.ok) {
    console.error("[cron/reconcile] 漂移告警", {
      driftUsd: result.driftUsd,
      realUsd: result.realUsd,
      ledgerUsd: result.ledgerUsd,
    });
  }
  return jsonOk({
    ...result,
    alert: result.ok ? null : "账本与上游余额不一致，请人工核对",
    ranAt: new Date().toISOString(),
  });
});
