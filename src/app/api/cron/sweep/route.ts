import { jsonOk, requireBearer, withRoute } from "@/lib/http";
import { getConfig } from "@/lib/config";
import { sweepStaleActivations, reconcileAbandonedActivations } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 保底回收入口：把「取号超时仍未收到验证码」的激活取消掉，释放上游占用。
 *
 * 为什么不只靠 Vercel Cron：Hobby 套餐 cron 每天最多 1 次，16 分钟的回收窗口
 * 靠天级任务根本来不及。所以这里做成**可被外部定时器打**的端点（Bearer CRON_SECRET），
 * 建议每 5 分钟打一次；同时轮询接口里也有机会式兜底（见 maybeSweepStaleActivations）。
 *
 * 计费口径：回收成功**不退还**卡密余额，只释放上游占用。详见 sweepStaleActivations。
 */
export const GET = withRoute(async (request: Request) => {
  const config = getConfig();
  requireBearer(request, config.CRON_SECRET, "Cron 鉴权失败");
  /*
   * 两件事一起做：
   *   sweep    —— 主动回收「超时还没收到码」的号，释放上游库存（不退卡密余额）
   *   reconcile —— 核对被遗弃的 waiting：上游出码就补记、上游取消就退款
   *
   * 前者受 autoCancelMinutes 开关控制（老板当前设为关闭），后者是资金安全，
   * 独立于开关、始终执行。
   */
  const result = await sweepStaleActivations();
  const abandoned = await reconcileAbandonedActivations();
  return jsonOk({ ...result, abandoned, ranAt: new Date().toISOString() });
});
