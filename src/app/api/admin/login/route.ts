import { z } from "zod";
import { assertLoginRateLimit, buildAdminCookie, clearLoginAttempts, clientIp, recordLoginFailure, verifyAdminToken } from "@/lib/admin";
import { jsonOk, readJsonBody, unauthorized, withRoute } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ token: z.string().min(1, "请输入管理口令") });

/**
 * 后台登录：校验口令 → 下发 HttpOnly Cookie。
 * 同 IP 每分钟最多 10 次尝试，失败也计数，防暴力破解。
 */
export const POST = withRoute(async (request: Request) => {
  const ip = clientIp(request);
  assertLoginRateLimit(ip);

  const body = await readJsonBody(request, BodySchema);
  if (!verifyAdminToken(body.token)) {
    recordLoginFailure(ip);
    throw unauthorized("管理口令错误");
  }

  clearLoginAttempts(ip);
  const headers = new Headers();
  headers.append("set-cookie", buildAdminCookie());
  return jsonOk({ ok: true }, { headers });
});
