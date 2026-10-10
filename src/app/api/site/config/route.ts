import { jsonOk, withRoute } from "@/lib/http";
import { effectiveLdcRate } from "@/lib/money";
import { getSiteSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公开站点配置：首页与接码台要展示的**非敏感**项。
 *
 * 刻意白名单输出——绝不要把 ADMIN_TOKEN / LDC key / 数据库串带进来。
 * 表里只有：汇率、面值档位、可取消锁定时长、超时回收分钟数。
 */
export const GET = withRoute(async () => {
  const settings = await getSiteSettings();

  return jsonOk({
    rateLdcPerUsd: settings.rateLdcPerUsd.toFixed(2),
    /** 含 markup 的实际换算比率，前端直接用来算售价。 */
    effectiveRateLdcPerUsd: effectiveLdcRate(
      settings.rateLdcPerUsd.toFixed(2),
      settings.markupPct,
    ).toFixed(2),
    markupPct: settings.markupPct,
    cancelLockSeconds: settings.cancelLockSeconds,
    /** 超时回收：取号后多少分钟没收到码就自动停用（前端要写进提示文案）。 */
    autoCancelMinutes: settings.autoCancelMinutes,
    faceValuePresets: settings.faceValuePresets,
  });
});
