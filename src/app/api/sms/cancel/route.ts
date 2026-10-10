import { z } from "zod";
import { jsonOk, readJsonBody, requireSession, withRoute } from "@/lib/http";
import { cancelActivation } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ activationId: z.string().min(1) });

/** 取消：setStatus(8) 成功后才回补，同时把 Activation.status 置 cancelled。 */
export const POST = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const { activationId } = await readJsonBody(request, BodySchema);
  return jsonOk(await cancelActivation({ keyId, activationId }));
});
