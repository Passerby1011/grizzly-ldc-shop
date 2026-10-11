import { z } from "zod";
import { jsonOk, readJsonBody, requireSession, withRoute, badRequest } from "@/lib/http";
import { checkFaceAmount } from "@/lib/face-value";
import { createTopupOrder } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  amountUsd: z.union([z.number(), z.string()]),
});

/**
 * 给**当前已登录的卡密**充值。
 *
 * 关键安全点：目标卡密来自会话（requireSession），**不接受前端传 keyId** ——
 * 否则任何人都能把余额充到别人卡上，等于替他人买单。
 */
export const POST = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const body = await readJsonBody(request, BodySchema);

  const check = checkFaceAmount(body.amountUsd);
  if (!check.ok) throw badRequest(check.reason ?? "金额不合法");

  return jsonOk(await createTopupOrder({ keyId, amountUsd: check.value }));
});
