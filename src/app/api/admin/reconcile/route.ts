import { jsonOk, withRoute } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { runReconcile } from "@/lib/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动触发对账（写快照 + 运行记录）。 */
export const POST = withRoute(async (request: Request) => {
  requireAdmin(request);
  const result = await runReconcile();
  if (!result.ok) console.error("[reconcile] 漂移告警", result.message);
  return jsonOk(result);
});
