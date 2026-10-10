import { z } from "zod";
import { jsonOk, readJsonBody, requireSession, withRoute } from "@/lib/http";
import { startActivation } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  service: z.string().min(1),
  country: z.union([z.string(), z.number()]).transform((value) => String(value)),
  /* 可选：手动指定愿意支付的最高价（美元） */
  maxPriceUsd: z.union([z.number(), z.string()]).optional(),
});

/** 取号：上限预扣 → getNumber → 写 Activation → 差额退回。 */
export const POST = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const body = await readJsonBody(request, BodySchema);
  const result = await startActivation({
    keyId,
    service: body.service,
    country: body.country,
    priceUsd: body.maxPriceUsd,
  });
  return jsonOk(result);
});
