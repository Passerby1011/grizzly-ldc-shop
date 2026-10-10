import { z } from "zod";
import { jsonOk, readQuery, requireSession, withRoute } from "@/lib/http";
import { pollActivation } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ activationId: z.string().min(1) });

/** 前端每 4 秒轮询一次；命中 STATUS_OK 时写库并返回验证码。 */
export const GET = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const { activationId } = readQuery(request, QuerySchema);
  return jsonOk(await pollActivation({ keyId, activationId }));
});
