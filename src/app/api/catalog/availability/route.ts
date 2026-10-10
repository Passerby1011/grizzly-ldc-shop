import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getNumbersStatusCached } from "@/lib/grizzly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ country: z.string().min(1) });

/** `?country=<id|any>` → getNumbersStatus（键 = 服务_运营商，值 = 可用数量）。 */
export const GET = withRoute(async (request: Request) => {
  const { country } = readQuery(request, QuerySchema);
  const items = await getNumbersStatusCached(country);
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return jsonOk({ country, items, total });
});
