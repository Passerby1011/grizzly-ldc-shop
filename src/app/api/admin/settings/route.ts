import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { jsonOk, readJsonBody, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";
import { getSiteSettingsView, updateSiteSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    rateLdcPerUsd: z.union([z.number(), z.string()]).optional(),
    markupPct: z.coerce.number().min(0).max(10000).optional(),
    cancelLockSeconds: z.coerce.number().min(0).max(3600).optional(),
    cancelRetrySeconds: z.coerce.number().min(0).max(3600).optional(),
    safetyBufferUsd: z.union([z.number(), z.string()]).optional(),
    autoCancelMinutes: z.coerce.number().min(0).max(1440).optional(),
    faceValuePresets: z.array(z.coerce.number().positive()).min(1).max(12).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要修改的字段" })
  .refine(
    (v) => v.rateLdcPerUsd === undefined || Number(v.rateLdcPerUsd) > 0,
    { message: "汇率必须大于 0", path: ["rateLdcPerUsd"] },
  )
  .refine(
    (v) => v.safetyBufferUsd === undefined || Number(v.safetyBufferUsd) >= 0,
    { message: "安全缓冲不能为负", path: ["safetyBufferUsd"] },
  );

function serialize(view: Awaited<ReturnType<typeof getSiteSettingsView>>) {
  return {
    effective: {
      rateLdcPerUsd: view.effective.rateLdcPerUsd.toFixed(2),
      markupPct: view.effective.markupPct,
      cancelLockSeconds: view.effective.cancelLockSeconds,
      cancelRetrySeconds: view.effective.cancelRetrySeconds,
      safetyBufferUsd: view.effective.safetyBufferUsd.toFixed(2),
      autoCancelMinutes: view.effective.autoCancelMinutes,
      faceValuePresets: view.effective.faceValuePresets,
    },
    envFallback: {
      rateLdcPerUsd: view.envFallback.rateLdcPerUsd.toFixed(2),
      markupPct: view.envFallback.markupPct,
      cancelLockSeconds: view.envFallback.cancelLockSeconds,
      cancelRetrySeconds: view.envFallback.cancelRetrySeconds,
      safetyBufferUsd: view.envFallback.safetyBufferUsd.toFixed(2),
      autoCancelMinutes: view.envFallback.autoCancelMinutes,
      faceValuePresets: view.envFallback.faceValuePresets,
    },
    fromDb: view.fromDb,
    hints: {
      rateLdcPerUsd: "1 美元 Grizzly 余额卖多少 LDC 积分",
      markupPct: "叠加在汇率之上的毛利百分比",
      cancelLockSeconds: "取号后可取消的最短等待秒数（上游实测约 60 秒内会被拒）",
      cancelRetrySeconds:
        "取消失败后的重试锁定秒数（默认 150 = 2.5 分钟）。上游解锁时机不可预测，锁一小段让买家到点再试，避免连点刷上游",
      safetyBufferUsd: "不可被动用的安全缓冲（美元），防账本与真实余额偏差导致超卖",
      autoCancelMinutes:
        "取号后多少分钟仍未收到验证码就自动取消激活（止损用，取消后不退还卡密余额）；0 = 关闭",
      faceValuePresets: "首页面值档位（美元）",
    },
  };
}

/** 读取当前设置，同时给出环境变量回退值便于对照。 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  return jsonOk(serialize(await getSiteSettingsView()));
});

/** 局部更新设置。只写显式传入的字段，不会把环境变量兜底值固化进库。 */
export const PUT = withRoute(async (request: Request) => {
  requireAdmin(request);
  const body = await readJsonBody(request, BodySchema);

  await updateSiteSettings({
    rateLdcPerUsd: body.rateLdcPerUsd !== undefined ? dec(body.rateLdcPerUsd) : undefined,
    markupPct: body.markupPct,
    cancelLockSeconds: body.cancelLockSeconds,
    cancelRetrySeconds: body.cancelRetrySeconds,
    safetyBufferUsd: body.safetyBufferUsd !== undefined ? dec(body.safetyBufferUsd) : undefined,
    autoCancelMinutes: body.autoCancelMinutes,
    faceValuePresets: body.faceValuePresets,
  });

  return jsonOk(serialize(await getSiteSettingsView()));
});
