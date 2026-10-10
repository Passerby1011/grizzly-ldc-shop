import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { queryAndSettleOrder } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ outTradeNo: z.string().min(1) });

/** 主动查 LDC 兜底补单：本地还是 pending 而上游已成功时，立刻发卡密。 */
export const GET = withRoute(async (request: Request) => {
  const { outTradeNo } = readQuery(request, QuerySchema);
  return jsonOk(await queryAndSettleOrder(outTradeNo));
});
