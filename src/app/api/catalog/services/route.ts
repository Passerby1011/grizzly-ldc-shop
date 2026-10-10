import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getServicesCached } from "@/lib/grizzly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ q: z.string().optional() });

/** 服务列表（进程内缓存 10 分钟）。 */
export const GET = withRoute(async (request: Request) => {
  const { q } = readQuery(request, QuerySchema);
  let services = await getServicesCached();
  if (q) {
    const needle = q.toLowerCase();
    services = services.filter(
      (item) => item.code.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle),
    );
  }
  return jsonOk({ services, count: services.length });
});
