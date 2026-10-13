import { z } from "zod";
import { jsonOk, readJsonBody, requireSession, withRoute } from "@/lib/http";
import { startActivation } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * 注意：这里**不接受**客户端传入的价格。
 *
 * 曾经有个 maxPriceUsd 入参（原意是"我愿意支付的最高价"），但它直通
 * startActivation 的 priceUsd 覆盖分支，会让调用者自己决定扣多少钱，
 * 而且取号成功后这个数字还会被 observe() 写进**全局** PriceCache
 * （PriceCache 是按 (service,country) 唯一的共享表，而上游 getPrices
 * 恒返回 BAD_ACTION，所以缓存就是唯一生效的价格来源）。
 * 结果：任何人用一张自己的卡就能把某个服务组合的售价永久改写，
 * 再取消把本金拿回 —— 影响的是所有后续买家的资金。
 *
 * 价格一律由服务端 quote 决定。
 */
const BodySchema = z.object({
  service: z.string().min(1),
  country: z.union([z.string(), z.number()]).transform((value) => String(value)),
});

/** 取号：上限预扣 → getNumber → 写 Activation → 差额退回。 */
export const POST = withRoute(async (request: Request) => {
  const keyId = requireSession(request);
  const body = await readJsonBody(request, BodySchema);
  const result = await startActivation({
    keyId,
    service: body.service,
    country: body.country,
  });
  return jsonOk(result);
});
