import Link from "next/link";
import { tryGetConfig } from "@/lib/config";
import { effectiveLdcRate, usdToLdc } from "@/lib/money";
import { getSiteSettings } from "@/lib/settings";
import { BuyButton } from "./_components/BuyButton";
import { CustomAmountBuy } from "./_components/CustomAmountBuy";

export const dynamic = "force-dynamic";

function StepCard({ index, title, body }: { index: number; title: string; body: string }) {
  return (
    <div className="card-quiet flex gap-3">
      <span className="step-dot">{index}</span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="muted mt-1 text-[13px] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

export default async function HomePage() {
  const config = tryGetConfig();

  if (!config) {
    return (
      <div className="card card-lit">
        <h1 className="text-lg font-semibold">站点尚未配置</h1>
        <p className="muted mt-2">
          请先在部署环境里填好环境变量（参考 <code className="code-display">.env.example</code>），再访问本页。
        </p>
      </div>
    );
  }

  /* 汇率与面值档位从数据库设置读取（后台改完首页立刻生效，无需重新部署） */
  const settings = await getSiteSettings();
  const effectiveRate = effectiveLdcRate(settings.rateLdcPerUsd, settings.markupPct);

  const packages = settings.faceValuePresets.map((faceUsd) => ({
    faceUsd,
    amountLdc: usdToLdc(faceUsd, settings.rateLdcPerUsd, settings.markupPct).toFixed(2),
  }));

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="card card-lit overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-xl space-y-3">
            <span className="badge badge-info">LINUX DO Credit 结算</span>
            <h1 className="text-3xl font-semibold leading-tight">
              把 Grizzly 余额切成分面值的卡密
            </h1>
            <p className="muted leading-relaxed">
              买一张卡密，到{" "}
              <Link href="/shop" className="font-medium" style={{ color: "rgb(var(--brand))" }}>
                接码台
              </Link>{" "}
              自助选国家与服务、实时接码。余额按次扣费，取号失败或取消会自动回补。
            </p>
          </div>

          <div
            className="rounded-2xl px-5 py-4"
            style={{
              background: "rgb(var(--brand) / 0.1)",
              border: "1px solid rgb(var(--brand) / 0.32)",
            }}
          >
            <p className="faint">当前汇率</p>
            <p className="tnum mt-1 text-2xl font-semibold" style={{ color: "rgb(var(--brand))" }}>
              $1 ≈ {effectiveRate.toFixed(2)} LDC
            </p>
            <p className="faint mt-1">
              1 美元 Grizzly 余额 = {settings.rateLdcPerUsd.toFixed(2)} LDC
              {settings.markupPct > 0 ? ` + ${settings.markupPct}%` : ""}
            </p>
          </div>
        </div>
      </section>

      {/* 面值档位 */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">选择面值</h2>
          <p className="faint">卡密一经售出不退不换</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {packages.map((item) => (
            <div key={item.faceUsd} className="card card-lit flex flex-col justify-between gap-5">
              <div>
                <p className="faint">Grizzly 面值</p>
                <p className="tnum mt-1 text-4xl font-semibold tracking-tight">
                  ${item.faceUsd.toFixed(2)}
                </p>
                <div className="divider my-3" />
                <div className="flex items-baseline justify-between">
                  <span className="faint">售价</span>
                  <span className="tnum text-base font-medium" style={{ color: "rgb(var(--brand))" }}>
                    {item.amountLdc} LDC
                  </span>
                </div>
              </div>
              <BuyButton faceUsd={item.faceUsd} amountLdc={item.amountLdc} />
            </div>
          ))}
        </div>
      </section>

      {/* 自定义金额 */}
      <section>
        <CustomAmountBuy />
      </section>

      {/* 流程 */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">购买与使用流程</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <StepCard index={1} title="下单付款" body="点套餐按钮跳到 LINUX DO Credit 收银台，用积分完成支付。" />
          <StepCard
            index={2}
            title="立即保存卡密"
            body="支付成功后自动跳回接码台，卡密明文只展示这一次，过期无法找回。"
          />
          <StepCard
            index={3}
            title="自助接码"
            body="贴入卡密，选国家与服务（会立即给出估价），点获取号码，验证码出来后自动扣费。"
          />
          <StepCard
            index={4}
            title="不想要可取消"
            body="上游取号后约 60 秒内不允许取消；超过锁定时间即可取消，余额自动回补。"
          />
        </div>
      </section>

      {/* 说明 */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="card-quiet space-y-2">
          <h2 className="text-sm font-semibold">关于估价</h2>
          <p className="muted text-[13px] leading-relaxed">
            上游价格接口在本 host 不可用，所以估价来自「上游尝试 → 本地成交成本缓存 → 兜底值」。
            取号时按上限预扣，成功拿到号码后按真实成本退回差额，失败则全额退回。
          </p>
        </div>
        <div className="card-quiet space-y-2">
          <h2 className="text-sm font-semibold">关于余额</h2>
          <p className="muted text-[13px] leading-relaxed">
            每张卡密在卖出时即从上游余额中预留对应额度，别人无法提前花掉你卡密里的钱。
            每次扣费与回补都有流水记录，可联系卖家对账。
          </p>
        </div>
      </section>
    </div>
  );
}
