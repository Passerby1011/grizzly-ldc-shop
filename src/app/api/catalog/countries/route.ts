import { z } from "zod";
import { jsonOk, readQuery, withRoute } from "@/lib/http";
import { getCountriesCached, type GrizzlyCountry } from "@/lib/grizzly";
import { displayCountryName } from "@/lib/service-names.zh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  visible: z.enum(["0", "1"]).optional(),
  q: z.string().optional(),
});

/**
 * 国家列表（进程内缓存 10 分钟）。
 *
 * 关键：上游 `chn` 字段有 104 个国家是空的（实测 2026-10-10），
 * 所以**在这里就把展示名算好**下发，不要让每个前端各自维护一份补齐逻辑。
 * - `name`：展示名（上游 chn → 本地补齐表 → eng）
 * - `chn`：保留上游原值，便于排障与前端特殊处理
 */
function decorate(country: GrizzlyCountry) {
  return {
    ...country,
    name: displayCountryName(country.eng, country.chn),
  };
}

export const GET = withRoute(async (request: Request) => {
  const { visible, q } = readQuery(request, QuerySchema);
  let countries = await getCountriesCached();
  if (visible !== "0") countries = countries.filter((item) => item.visible !== 0);

  let decorated = countries.map(decorate);

  if (q) {
    // 搜索要同时命中：展示名（含本地补齐的中文）、英文名、俄文名、ID
    const needle = q.trim().toLowerCase();
    decorated = decorated.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.eng.toLowerCase().includes(needle) ||
        (item.chn ?? "").toLowerCase().includes(needle) ||
        (item.rus ?? "").toLowerCase().includes(needle) ||
        String(item.id) === needle,
    );
  }

  return jsonOk({ countries: decorated, count: decorated.length });
});
