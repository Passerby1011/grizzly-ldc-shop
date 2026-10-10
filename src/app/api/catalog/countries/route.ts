import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getCountriesCached } from "@/lib/grizzly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  visible: z.enum(["0", "1"]).optional(),
  q: z.string().optional(),
});

/** 国家列表（进程内缓存 10 分钟）。 */
export const GET = withRoute(async (request: Request) => {
  const { visible, q } = readQuery(request, QuerySchema);
  let countries = await getCountriesCached();
  if (visible !== "0") countries = countries.filter((item) => item.visible !== 0);
  if (q) {
    const needle = q.toLowerCase();
    countries = countries.filter(
      (item) =>
        item.eng.toLowerCase().includes(needle) ||
        (item.chn ?? "").toLowerCase().includes(needle) ||
        (item.rus ?? "").toLowerCase().includes(needle),
    );
  }
  return jsonOk({ countries, count: countries.length });
});
