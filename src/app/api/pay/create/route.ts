import { z } from "zod";
import { jsonOk, readJsonBody, withRoute, conflict, ERROR_CODES } from "@/lib/http";
import { dec } from "@/lib/money";
import { checkPoolCapacity } from "@/lib/pool";
import { createPayOrder } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  faceUsd: z.union([z.number(), z.string()]),
});

export const POST = withRoute(async (request: Request) => {
  const body = await readJsonBody(request, BodySchema);
  const faceUsd = dec(body.faceUsd);

  /* 卖之前先看一眼池子：只有实时读到 Grizzly 余额时才硬拦，降级读数不拦。 */
  const check = await checkPoolCapacity(faceUsd);
  if (!check.ok && check.pool.source === "grizzly") {
    throw conflict(ERROR_CODES.POOL_EXHAUSTED, "可售余额不足，请稍后再试或联系卖家", {
      requiredUsd: check.requiredUsd.toFixed(2),
      availableUsd: check.availableUsd.toFixed(2),
    });
  }

  return jsonOk(await createPayOrder(faceUsd));
});
