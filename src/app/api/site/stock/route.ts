import { jsonOk, withRoute } from "@/lib/http";
import { getSiteSettings } from "@/lib/settings";
import { getPoolState } from "@/lib/pool";
import { dec, usdToLdc } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公开的「可售余额」概览：买家据此判断还能不能买、能买多少。
 *
 * 刻意**只暴露必要数字**：
 *   - availableUsd：可售余额（已扣除已售预留与安全缓冲）
 *   - maxFaceUsd：单笔能买的最大面值
 *   - affordablePresets：面值档位里买得起的那些
 * 绝不返回上游真实余额、已分配额、安全缓冲等内部数字 —— 那些属于经营信息，
 * 后台 overview 才有（需鉴权）。
 *
 * 上游读不到时降级返回 degraded=true 且不给具体数字，避免显示假数据误导下单。
 */
export const GET = withRoute(async () => {
  const settings = await getSiteSettings();

  let availableUsd: string | null = null;
  let degraded = true;
  let maxFaceUsd: string | null = null;
  let affordablePresets: number[] = [];

  try {
    const pool = await getPoolState();
    degraded = pool.degraded;
    /* 只有实时读到上游余额时才给数字；降级读数不展示（避免误判） */
    if (!pool.degraded) {
      const available = pool.availableUsd;
      availableUsd = available.gt(0) ? available.toFixed(2) : "0.00";
      const max = available.gt(0) ? available : dec(0);
      maxFaceUsd = max.toFixed(2);
      affordablePresets = settings.faceValuePresets.filter((p) => dec(p).lte(available));
    }
  } catch {
    /* 池子读不到 → 保持 degraded，前端显示「暂时查不到」 */
  }

  /* 买家视角的 LDC 折算：按当前汇率，让「能买多少」更直观 */
  const availableLdc =
    availableUsd !== null
      ? usdToLdc(availableUsd, settings.rateLdcPerUsd, settings.markupPct).toFixed(2)
      : null;

  return jsonOk({
    degraded,
    availableUsd,
    availableLdc,
    maxFaceUsd,
    affordablePresets,
    faceValuePresets: settings.faceValuePresets,
  });
});
