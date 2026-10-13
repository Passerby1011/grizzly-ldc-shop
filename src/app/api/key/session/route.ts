import { z } from "zod";
import { notFound, jsonOk, readJsonBody, withRoute, appendSessionCookie, forbidden, badRequest } from "@/lib/http";
import { getPrisma } from "@/lib/db";
import { hashCode, maskCode, normalizeCode } from "@/lib/keycodec";
import { dec } from "@/lib/money";
import { canLogin } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ code: z.string().min(1) });

/** 贴卡密登录：校验 → 返回掩码卡密 + 余额，并把签名会话写进 HttpOnly Cookie。 */
export const POST = withRoute(async (request: Request) => {
  const { code } = await readJsonBody(request, BodySchema);
  const normalized = normalizeCode(code);
  if (!normalized) throw badRequest("卡密格式不正确，应为 GS-XXXX-XXXX-XXXX-XXXX");

  const key = await getPrisma().cardKey.findUnique({ where: { codeHash: hashCode(normalized) } });
  if (!key) throw notFound("卡密不存在");
  /*
   * 用 canLogin 而不是 isKeyUsable：余额为 0（depleted）的卡也要能进来 ——
   * 否则用户余额花完就再也登不进来，连"给这张卡充值"都做不到。
   * 能不能取号是另一回事，由 isKeyUsable 在取号时把关。
   */
  if (!canLogin(key)) throw forbidden("卡密已作废或已过期");

  const headers = new Headers();
  appendSessionCookie(headers, key.id);

  return jsonOk(
    {
      keyId: key.id,
      maskedCode: maskCode(normalized),
      codePrefix: key.codePrefix,
      balanceUsd: dec(key.balanceUsd.toString()).toFixed(2),
      faceUsd: dec(key.faceUsd.toString()).toFixed(2),
      status: key.status,
      expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    },
    { headers },
  );
});
