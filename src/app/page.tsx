import Link from "next/link";
import { tryGetConfig } from "@/lib/config";
import { usdToLdc } from "@/lib/money";
import { BuyButton } from "./_components/BuyButton";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const config = tryGetConfig();

  if (!config) {
    return (
      <div className="card">
        <h1 className="text-lg font-semibold">站点尚未配置</h1>
        <p className="muted mt-2">
          请先在部署环境里填好 `.env`（参考 `.env.example`），再访问本页。
        </p>
      </div>
    );
  }

  const packages = config.presets.map((faceUsd) => ({
    faceUsd,
    amountLdc: usdToLdc(faceUsd, config.RATE_LDC_PER_USD, config.MARKUP_PCT).toFixed(2),
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">把 Grizzly 余额切成分面值的卡密</h1>
        <p className="muted">
          用 LINUX DO Credit 付款，拿到卡密后到{" "}
          <Link href="/shop" className="text-indigo-400 hover:text-indigo-300">
            接码台
          </Link>{" "}
          自助接码。当前汇率：1 USD Grizzly 余额 = {config.RATE_LDC_PER_USD} LDC
          {config.MARKUP_PCT > 0 ? `（另加 ${config.MARKUP_PCT}% 毛利）` : ""}。
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {packages.map((item) => (
          <div key={item.faceUsd} className="card flex flex-col justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Grizzly 面值</p>
              <p className="mt-1 text-3xl font-semibold">${item.faceUsd.toFixed(2)}</p>
              <p className="muted mt-2">售价 {item.amountLdc} LDC</p>
            </div>
            <BuyButton faceUsd={item.faceUsd} amountLdc={item.amountLdc} />
          </div>
        ))}
      </section>

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold text-slate-200">购买流程</h2>
        <ol className="muted list-decimal space-y-1 pl-5">
          <li>点套餐按钮，跳到 LINUX DO Credit 收银台付款。</li>
          <li>支付成功后自动回到接码台，卡密明文只在这一步展示，请立即保存。</li>
          <li>贴入卡密即可选国家 / 服务、估价、取号，验证码出来后自动扣费。</li>
          <li>不想要了在激活完成前点取消，余额自动回补。</li>
        </ol>
      </section>

      <section className="card space-y-2">
        <h2 className="text-sm font-semibold text-slate-200">关于估价</h2>
        <p className="muted">
          上游 `getPrices` 系列接口在本 host 实测返回 `BAD_ACTION`，所以本店估价来自
          「上游尝试 → 本地成交成本缓存 → 兜底值」。取号时按上限预扣，
          成功拿到号码后按真实成本退回差额，失败则全额退回。
        </p>
      </section>
    </div>
  );
}
