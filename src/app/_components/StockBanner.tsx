"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 可售余额卡片：让买家在买之前就知道「还能不能买、能买多少」。
 *
 * 显示的是**可售余额**（上游真实余额 − 已售预留 − 安全缓冲），不是卖家的
 * 上游总余额 —— 后者属于经营信息，公开接口刻意不返回。
 *
 * 上游读不到（degraded）时明确说"暂时查不到"，不给数字 —— 避免用假数据误导下单。
 */

interface StockView {
  degraded: boolean;
  availableUsd: string | null;
  availableLdc: string | null;
  maxFaceUsd: string | null;
  affordablePresets: number[];
  faceValuePresets: number[];
}

export function StockBanner() {
  const [stock, setStock] = useState<StockView | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/site/stock", { cache: "no-store" });
      const payload = (await res.json()) as { ok: boolean; data?: StockView };
      if (payload.ok && payload.data) setStock(payload.data);
    } catch {
      /* 拉不到就保持 null，UI 显示"暂时查不到" */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    /* 30 秒刷新一次：余额会被别人买走，太频繁没必要、太慢会误导 */
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const unavailable = loading || !stock || stock.degraded || stock.availableUsd === null;
  const soldOut = !unavailable && Number(stock.availableUsd) <= 0;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-2xl px-5 py-4"
      style={{
        background: soldOut ? "rgb(var(--danger) / 0.08)" : "rgb(var(--ok) / 0.09)",
        border: `1px solid ${soldOut ? "rgb(var(--danger) / 0.35)" : "rgb(var(--ok) / 0.35)"}`,
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{
            background: unavailable
              ? "rgb(var(--fg-faint))"
              : soldOut
                ? "rgb(var(--danger))"
                : "rgb(var(--ok))",
          }}
          aria-hidden="true"
        />
        <div>
          <p className="text-xs" style={{ color: "rgb(var(--fg-muted))" }}>
            当前可售余额
          </p>
          <p
            className="tnum text-2xl font-semibold leading-tight"
            style={{
              color: unavailable
                ? "rgb(var(--fg-faint))"
                : soldOut
                  ? "rgb(var(--danger))"
                  : "rgb(var(--ok))",
            }}
          >
            {loading
              ? "读取中…"
              : unavailable
                ? "暂时查不到"
                : soldOut
                  ? "已售罄"
                  : `$${stock.availableUsd}`}
            {!unavailable && !soldOut ? <span className="ml-1 text-sm font-normal">USD</span> : null}
          </p>
        </div>
      </div>

      <div className="text-right text-xs" style={{ color: "rgb(var(--fg-muted))" }}>
        {loading ? (
          <p>&nbsp;</p>
        ) : unavailable ? (
          <p>上游暂时不可用，稍后自动重试</p>
        ) : soldOut ? (
          <p>余额已用完，补货后再来</p>
        ) : (
          <>
            <p>
              单笔最多可买{" "}
              <span className="tnum font-medium" style={{ color: "rgb(var(--fg))" }}>
                ${stock.maxFaceUsd}
              </span>
            </p>
            <p className="mt-0.5">
              {stock.affordablePresets.length > 0 ? (
                <>
                  可买档位{" "}
                  <span className="tnum font-medium" style={{ color: "rgb(var(--fg))" }}>
                    {stock.affordablePresets.map((p) => `$${p}`).join(" / ")}
                  </span>
                </>
              ) : (
                "任意金额档位已超出可售余额"
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
