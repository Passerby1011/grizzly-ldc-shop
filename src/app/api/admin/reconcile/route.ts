import { jsonOk, requireBearer, withRoute } from "@/lib/http";
import { getConfig } from "@/lib/config";
import { runReconcile } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动触发对账（写快照 + 运行记录）。 */
export const POST = withRoute(async (request: Request) => {
  requireBearer(request, getConfig().ADMIN_TOKEN, "管理口令错误");
  const result = await runReconcile();
  if (!result.ok) console.error("[reconcile] 漂移告警", result.message);
  return jsonOk(result);
});
