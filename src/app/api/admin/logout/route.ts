import { buildClearAdminCookie } from "@/lib/admin";
import { jsonOk, withRoute } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 后台登出：清 Cookie。不要求已登录（重复调用无副作用）。 */
export const POST = withRoute(async () => {
  const headers = new Headers();
  headers.append("set-cookie", buildClearAdminCookie());
  return jsonOk({ ok: true }, { headers });
});
