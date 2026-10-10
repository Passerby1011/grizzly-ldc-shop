import { getConfig } from "@/lib/config";
import { getPrisma } from "@/lib/db";
import { dec } from "@/lib/money";
import { isTradeSuccess, verifyEpaySign } from "@/lib/ldc";
import { fulfillPaidOrder } from "@/lib/pool";
import { getSearchParams } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * LDC 异步通知（HTTP GET）。
 * 流程：验签 → 金额比对 → 幂等入账 → 发卡密 → 返回 `success`。
 * 必须返回 HTTP 200 且响应体为 `success`，否则平台重试最多 5 次。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const config = getConfig();
    const params = Object.fromEntries(getSearchParams(request).entries());

    if (!verifyEpaySign(params, config.LDC_KEY)) {
      console.error("[pay/notify] 验签失败", { outTradeNo: params.out_trade_no });
      return text("invalid sign", 400);
    }
    const outTradeNo = params.out_trade_no;
    if (!outTradeNo) return text("missing out_trade_no", 400);
    if (!isTradeSuccess(params)) {
      console.error("[pay/notify] trade_status 非成功", { outTradeNo, status: params.trade_status });
      return text("invalid trade_status", 400);
    }

    const prisma = getPrisma();
    const order = await prisma.order.findUnique({ where: { outTradeNo } });
    if (!order) {
      console.error("[pay/notify] 订单不存在", { outTradeNo });
      return text("order not found", 404);
    }

    /* 金额比对：只接受与下单时一致的金额，防止被改价 */
    const paid = dec(params.money);
    if (!paid.eq(dec(order.amountLdc.toString()))) {
      console.error("[pay/notify] 金额不匹配", {
        outTradeNo,
        paid: paid.toFixed(2),
        expected: dec(order.amountLdc.toString()).toFixed(2),
      });
      return text("amount mismatch", 400);
    }

    const fulfilled = await fulfillPaidOrder({
      orderId: order.id,
      ldcTradeNo: params.trade_no ?? null,
      notify: params,
      trace: "notify",
    });
    for (const warning of fulfilled.warnings) console.error("[pay/notify]", warning);

    return text("success", 200);
  } catch (error) {
    console.error("[pay/notify] 处理失败", error);
    return text("error", 500);
  }
}
