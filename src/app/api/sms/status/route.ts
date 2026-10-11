import { z } from "zod";
import { jsonOk, readQuery, requireSession, withRoute } from "@/lib/http";
import { pollActivation, maybeSweepStaleActivations, maybeReconcileAbandoned } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ activationId: z.string().min(1) });

/** 前端每 4 秒轮询一次；命中 STATUS_OK 时写库并返回验证码。 */
export const GET = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const { activationId } = readQuery(request, QuerySchema);
  const result = await pollActivation({ keyId, activationId });

  /*
   * 机会式保底回收：不 await —— 回收慢/失败绝不能拖累「查验证码」这条主路径。
   * 同实例有 60 秒限流，所以绝大多数轮询只是一次命中索引的空查询。
   * 真正的频率保证靠 /api/cron/sweep 由外部定时器打（Hobby cron 每天只有 1 次）。
   */
  void maybeSweepStaleActivations();
  /* 弃单核账：买家走开后没人轮询的那些，靠这里机会式收口（上游出码补记 / 上游取消退款） */
  void maybeReconcileAbandoned();

  return jsonOk(result);
});
