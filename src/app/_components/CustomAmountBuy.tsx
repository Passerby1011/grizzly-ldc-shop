"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 自定义充值：任意金额（0.1 步长）。
 *
 * 报价一律回服务端算（/api/pay/quote），因为 LDC 金额是「向上取整到 2 位」，
 * 用 JS 浮点在前端复算会出现「显示 3.31、实收 3.30」这类偏差。
 * 这里只负责：输入校验的即时反馈、防抖报价、以及把合法金额交给下单。
 */

interface Quote {
  valid: boolean;
  reason?: string;
  step: string;
  faceUsd?: string;
  amountLdc?: string;
}

const STEP = "0.1";
const QUICK_ADD = ["1", "5", "10"] as const;

/** 把输入收敛成「最多一位小数」的字符串，顺便挡掉明显非法的字符。 */
function sanitize(raw: string): string {
  /* 只留数字与一个小数点 */
  let s = raw.replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot >= 0) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    /* 小数最多一位（步长 0.1） */
    s = s.slice(0, firstDot + 2);
  }
  /* 去掉多余前导零：007 → 7（但保留 0.5 这种） */
  if (/^0\d/.test(s)) s = s.replace(/^0+/, "");
  return s;
}

export function CustomAmountBuy() {
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  /* 输入 → 防抖报价（丢弃过期响应，避免乱序覆盖） */
  useEffect(() => {
    const value = input.trim();
    if (!value || value === ".") {
      setQuote(null);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pay/quote?faceUsd=${encodeURIComponent(value)}`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as { ok: boolean; data?: Quote };
        if (seq !== seqRef.current) return; // 过期响应丢弃
        if (payload.ok && payload.data) {
          setQuote(payload.data);
          setError(null);
        } else {
          setQuote(null);
        }
      } catch {
        if (seq === seqRef.current) setQuote(null);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [input]);

  const add = useCallback((delta: string) => {
    setInput((prev) => {
      const base = Number(prev || "0");
      const next = Math.round((base + Number(delta)) * 10) / 10;
      return next > 0 ? String(next) : "";
    });
  }, []);

  async function buy() {
    if (!quote?.valid || !quote.faceUsd) return;
    setBuying(true);
    setError(null);
    try {
      const res = await fetch("/api/pay/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ faceUsd: quote.faceUsd }),
      });
      const payload = (await res.json()) as
        | { ok: true; data: { payUrl: string } }
        | { ok: false; error: { message: string } };
      if (!payload.ok) throw new Error(payload.error.message);
      window.location.href = payload.data.payUrl;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "下单失败");
      setBuying(false);
    }
  }

  const showInvalid = input.trim() !== "" && quote !== null && !quote.valid;

  return (
    <div className="card card-lit space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">自定义金额</h2>
          <p className="faint mt-1">想充多少充多少，最小 {STEP} USD，必须是 {STEP} 的整数倍。</p>
        </div>
        <span className="badge badge-info">灵活充值</span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label className="label" htmlFor="custom-face">
            充值面值（USD）
          </label>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm"
              style={{ color: "rgb(var(--fg-faint))" }}
            >
              $
            </span>
            <input
              id="custom-face"
              className="input tnum pl-7 text-base"
              inputMode="decimal"
              placeholder="例如 2.5"
              value={input}
              onChange={(event) => setInput(sanitize(event.target.value))}
              aria-invalid={showInvalid}
              aria-describedby="custom-face-help"
            />
          </div>
        </div>

        <div className="flex gap-1">
          {QUICK_ADD.map((delta) => (
            <button key={delta} type="button" className="btn btn-ghost btn-sm" onClick={() => add(delta)}>
              +{delta}
            </button>
          ))}
          {input ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInput("")}>
              清空
            </button>
          ) : null}
        </div>
      </div>

      <div id="custom-face-help" className="min-h-[20px]">
        {showInvalid ? (
          <p className="text-xs" role="alert" style={{ color: "rgb(var(--danger))" }}>
            {quote?.reason}
          </p>
        ) : quote?.valid ? (
          <p className="text-xs" style={{ color: "rgb(var(--fg-muted))" }}>
            应付{" "}
            <span className="tnum font-medium" style={{ color: "rgb(var(--brand))" }}>
              {quote.amountLdc} LDC
            </span>
            <span className="faint"> · 面值 ${quote.faceUsd}</span>
          </p>
        ) : (
          <p className="faint">输入金额后自动显示应付积分</p>
        )}
      </div>

      {error ? (
        <p className="text-xs" role="alert" style={{ color: "rgb(var(--danger))" }}>
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={!quote?.valid || buying}
        onClick={() => void buy()}
      >
        {buying ? "正在跳转…" : quote?.valid ? `用 ${quote.amountLdc} LDC 购买` : "请输入合法金额"}
      </button>
    </div>
  );
}
