"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 给**当前已登录的这张卡**充值。
 *
 * 只能充自己的卡：目标由服务端会话决定（/api/key/topup 不接受前端传 keyId），
 * 所以这里没有"输入卡密"的入口，也就无法给别人充值。
 *
 * 金额规则与买卡完全一致（同一套 checkFaceAmount），报价同样回服务端算 ——
 * LDC 是「向上取整到 2 位」，前端复算会出现显示与实收不一致。
 */

const STEP = "0.01";
const QUICK_ADD = ["5", "10", "20", "50"] as const;

interface Quote {
  valid: boolean;
  reason?: string;
  faceUsd?: string;
  amountLdc?: string;
}

function sanitize(raw: string): string {
  let s = raw.replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot >= 0) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
    s = s.slice(0, firstDot + 3);
  }
  if (/^0\d/.test(s)) s = s.replace(/^0+/, "");
  return s;
}

export function TopupPanel({ balanceUsd, onDone }: { balanceUsd: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const value = input.trim();
    if (!value || value === ".") {
      setQuote(null);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pay/quote?faceUsd=${encodeURIComponent(value)}`, { cache: "no-store" });
        const payload = (await res.json()) as { ok: boolean; data?: Quote };
        if (seq !== seqRef.current) return;
        if (payload.ok && payload.data) setQuote(payload.data);
        else setQuote(null);
      } catch {
        if (seq === seqRef.current) setQuote(null);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [input]);

  async function submit() {
    if (!quote?.valid || !quote.faceUsd) return;
    setBuying(true);
    setError(null);
    try {
      const res = await fetch("/api/key/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: quote.faceUsd }),
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

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm w-full"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
      >
        + 给这张卡充值
      </button>
    );
  }

  return (
    <div
      className="space-y-3 rounded-xl p-3"
      style={{
        border: "1px solid rgb(var(--brand) / 0.3)",
        background: "rgb(var(--brand) / 0.05)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">给这张卡充值</p>
          <p className="faint mt-0.5">
            当前余额 ${balanceUsd}，充完直接累加，最小 {STEP} USD
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setOpen(false);
            setInput("");
            setQuote(null);
            setError(null);
          }}
        >
          收起
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[140px] flex-1">
          <div className="relative">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm"
              style={{ color: "rgb(var(--fg-faint))" }}
            >
              $
            </span>
            <input
              className="input tnum pl-7"
              inputMode="decimal"
              placeholder="充值金额"
              value={input}
              onChange={(event) => setInput(sanitize(event.target.value))}
              aria-label="充值金额（USD）"
            />
          </div>
        </div>
        <div className="flex gap-1">
          {QUICK_ADD.map((delta) => (
            <button
              key={delta}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                setInput((prev) => {
                  const next = Math.round((Number(prev || "0") + Number(delta)) * 100) / 100;
                  return next > 0 ? String(next) : "";
                })
              }
            >
              +{delta}
            </button>
          ))}
        </div>
      </div>

      {showInvalid ? (
        <p className="text-xs" role="alert" style={{ color: "rgb(var(--danger))" }}>
          {quote?.reason}
        </p>
      ) : quote?.valid ? (
        <p className="text-xs" style={{ color: "rgb(var(--fg-muted))" }}>
          充 <span className="tnum font-medium">${quote.faceUsd}</span> 需付{" "}
          <span className="tnum font-medium" style={{ color: "rgb(var(--brand))" }}>
            {quote.amountLdc} LDC
          </span>
          ，到账后余额变为{" "}
          <span className="tnum font-medium">
            ${(Number(balanceUsd) + Number(quote.faceUsd)).toFixed(2)}
          </span>
        </p>
      ) : (
        <p className="faint text-xs">输入金额后自动显示应付积分</p>
      )}

      {error ? (
        <p className="text-xs" role="alert" style={{ color: "rgb(var(--danger))" }}>
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn-primary btn-sm w-full"
        disabled={!quote?.valid || buying}
        onClick={() => void submit()}
      >
        {buying ? "正在跳转…" : quote?.valid ? `用 ${quote.amountLdc} LDC 充值` : "请输入合法金额"}
      </button>

      <p className="faint text-xs">
        付款后余额自动到账（通常几秒）。充值同样不退不换，未用掉的余额仍留在卡内可继续接码。
      </p>
    </div>
  );
}
