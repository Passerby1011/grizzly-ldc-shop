import { z } from "zod";
import { jsonOk, readJsonBody, withRoute, conflict, badRequest, ERROR_CODES } from "@/lib/http";
import { checkFaceAmount } from "@/lib/face-value";
import { checkPoolCapacity } from "@/lib/pool";
import { createPayOrder } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  faceUsd: z.union([z.number(), z.string()]),
});

export const POST = withRoute(async (request: Request) => {
  const body = await readJsonBody(request, BodySchema);

  /* 金额规则与 service 层共用同一个函数，避免「接口放行、服务拒绝」的不一致 */
  const check = checkFaceAmount(body.faceUsd);
  if (!check.ok) throw badRequest(check.reason ?? "金额不合法");
  const faceUsd = check.value;

  /* 卖之前先看一眼池子：只有实时读到 Grizzly 余额时才硬拦，降级读数不拦。 */
  const pool = await checkPoolCapacity(faceUsd);
  if (!pool.ok && pool.pool.source === "grizzly") {
    throw conflict(ERROR_CODES.POOL_EXHAUSTED, "可售余额不足，请稍后再试或联系卖家", {
      requiredUsd: pool.requiredUsd.toFixed(2),
      availableUsd: pool.availableUsd.toFixed(2),
    });
  }

  return jsonOk(await createPayOrder(faceUsd));
});
