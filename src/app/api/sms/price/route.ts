import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getNumbersStatusCached, getPriceProvider } from "@/lib/grizzly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  service: z.string().min(1),
  country: z.string().min(1),
});

/**
 * 估价 + 可用性。
 * 价格走 PriceProvider：上游 `getPrices` 系列实测返回 `BAD_ACTION`，
 * 所以这里是「先试 API → 静默降级到本地 PriceCache → 兜底常量」。
 */
export const GET = withRoute(async (request: Request) => {
  const { service, country } = readQuery(request, QuerySchema);
  const quote = await getPriceProvider().quote(service, country);

  let available: number | null = null;
  try {
    const items = await getNumbersStatusCached(country);
    if (items.length > 0) {
      available = items
        .filter((item) => item.service === service || item.key === service)
        .reduce((sum, item) => sum + item.count, 0);
    }
  } catch {
    available = null;
  }

  return jsonOk({
    service,
    country,
    priceUsd: quote.priceUsd.toFixed(2),
    source: quote.source,
    available,
    sellable: available === null ? null : available > 0,
    /* 预留上限：取号时按此值预扣，成交后按真实成本退回差额 */
    maxPriceUsd: quote.priceUsd.toFixed(2),
    disclaimer: "价格来自本地缓存/兜底值，可能略高于上游真实成本；成交后差额会自动退回卡密余额。",
  });
});
