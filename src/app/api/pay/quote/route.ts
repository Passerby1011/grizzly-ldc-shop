import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { checkFaceAmount, CUSTOM_FACE_STEP_USD } from "@/lib/face-value";
import { usdToLdc } from "@/lib/money";
import { getSiteSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ faceUsd: z.string() });

/**
 * 报价：只算钱，不下单、不碰上游、不写库。
 *
 * 为什么要有这个接口：前端必须显示**和实际扣费完全一致**的 LDC 金额。
 * LDC 报价是「向上取整到 2 位」（roundUp2），用 JS 浮点在前端复算会出现
 * 显示 3.31、实收 3.30 这类偏差，所以报价一律回服务端用同一套 Decimal 算。
 * 也不返回池子余额，避免泄露卖家库存。
 */
export const GET = withRoute(async (request: Request) => {
  const { faceUsd: raw } = readQuery(request, QuerySchema);

  const check = checkFaceAmount(raw);
  if (!check.ok) {
    return jsonOk({
      valid: false,
      reason: check.reason ?? "金额不合法",
      step: CUSTOM_FACE_STEP_USD,
    });
  }

  const settings = await getSiteSettings();
  const amountLdc = usdToLdc(check.value, settings.rateLdcPerUsd, settings.markupPct);

  return jsonOk({
    valid: true,
    step: CUSTOM_FACE_STEP_USD,
    faceUsd: check.value.toFixed(2),
    amountLdc: amountLdc.toFixed(2),
    rateLdcPerUsd: settings.rateLdcPerUsd.toFixed(2),
    markupPct: settings.markupPct,
  });
});
