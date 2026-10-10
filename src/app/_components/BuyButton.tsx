"use client";

import { useState } from "react";

interface BuyButtonProps {
  faceUsd: number;
  amountLdc: string;
}

export function BuyButton({ faceUsd, amountLdc }: BuyButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/pay/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ faceUsd }),
      });
      const payload = (await response.json()) as
        | { ok: true; data: { payUrl: string } }
        | { ok: false; error: { message: string } };
      if (!payload.ok) throw new Error(payload.error.message);
      window.location.href = payload.data.payUrl;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "下单失败");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-primary w-full" onClick={buy} disabled={busy}>
        {busy ? "正在跳转…" : `用 ${amountLdc} LDC 购买`}
      </button>
      {error ? (
        <p className="text-xs" role="alert" style={{ color: "rgb(var(--danger))" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
