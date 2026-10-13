import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getNumbersStatusCached } from "@/lib/grizzly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * country 只接受数字 ID 或 "any"。
 *
 * 以前只校验 min(1)，任意长字符串都能透传：既会按串给上游打请求，
 * 又会在服务端缓存里堆出无界条目（见 grizzly.ts 的 AVAILABILITY_CACHE_MAX）。
 * 白名单化后，滥用面从"任意串"收敛到"有限个合法值"。
 */
const COUNTRY_PATTERN = /^(\d{1,6}|any)$/;
const QuerySchema = z.object({
  country: z.string().min(1).max(16).regex(COUNTRY_PATTERN, "国家参数不合法"),
});

/** `?country=<id|any>` → getNumbersStatus（键 = 服务_运营商，值 = 可用数量）。 */
export const GET = withRoute(async (request: Request) => {
  const { country } = readQuery(request, QuerySchema);
  const items = await getNumbersStatusCached(country);
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return jsonOk({ country, items, total });
});
