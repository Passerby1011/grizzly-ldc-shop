"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayCountryName, displayServiceName } from "@/lib/service-names.zh";
import { ApiCallError, apiGet, apiPost, errorMessage } from "./_api";
import type {
  ActivationView,
  CountryView,
  MeView,
  OrderQueryView,
  PollView,
  QuoteView,
  ServiceView,
  SessionView,
} from "./_types";

/** 接码台轮询间隔：每 4 秒问一次上游状态。 */
const POLL_INTERVAL_MS = 4000;

/** 国家 + 服务都选好后，自动估价的防抖等待。 */
const QUOTE_DEBOUNCE_MS = 400;

/** 秒 → `mm:ss`（取消倒计时展示用）。 */
function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const rest = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

/** 从 409 的 details 里取 retryAfterSeconds（服务端建议的重试等待秒数）。 */
function retryAfterSecondsOf(error: unknown): number | null {
  if (!(error instanceof ApiCallError)) return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const value = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

export default function ShopPage() {
  const [codeInput, setCodeInput] = useState("");
  const [session, setSession] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [order, setOrder] = useState<OrderQueryView | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [countries, setCountries] = useState<CountryView[]>([]);
  const [services, setServices] = useState<ServiceView[]>([]);
  const [country, setCountry] = useState("");
  const [service, setService] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [quote, setQuote] = useState<QuoteView | null>(null);

  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [poll, setPoll] = useState<PollView | null>(null);
  /** 取消倒计时剩余秒数；null = 还没拿到服务端数据（按锁定处理）。 */
  const [cancelLeft, setCancelLeft] = useState<number | null>(null);
  /** 本轮倒计时的起始总秒数，用于算进度条百分比。 */
  const [cancelTotal, setCancelTotal] = useState<number | null>(null);
  /** 复制按钮的瞬时反馈。 */
  const [copied, setCopied] = useState(false);
  /** 估价请求序号：递增后丢弃过期响应，避免乱序覆盖。 */
  const quoteSeqRef = useRef(0);

  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const run = useCallback(async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag);
    setError(null);
    try {
      await fn();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, []);

  const login = useCallback(
    async (rawCode: string) => {
      const view = await apiPost<SessionView>("/api/key/session", { code: rawCode });
      setSession(view);
      setCodeInput("");
      setNotice(`已进入接码台：${view.maskedCode}，余额 ${view.balanceUsd} USD`);
      return view;
    },
    [],
  );

  /* 支付回跳：?order=xxx → 主动查单补发卡密 */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outTradeNo = params.get("order");
    if (!outTradeNo) return;
    void (async () => {
      try {
        const view = await apiGet<OrderQueryView>(
          `/api/pay/query?outTradeNo=${encodeURIComponent(outTradeNo)}`,
        );
        setOrder(view);
        if (view.code) {
          setCodeInput(view.code);
          try {
            await login(view.code);
          } catch {
            setNotice("请复制卡密并手动保存，然后点「进入接码台」。");
          }
        }
      } catch (caught) {
        setOrderError(errorMessage(caught));
      }
    })();
  }, [login]);

  /* 国家 / 服务列表 */
  useEffect(() => {
    void (async () => {
      try {
        const data = await apiGet<{ countries: CountryView[] }>("/api/catalog/countries");
        setCountries(data.countries);
      } catch {
        // 列表拉不到不影响已登录用户
      }
      try {
        const data = await apiGet<{ services: ServiceView[] }>("/api/catalog/services");
        setServices(data.services);
      } catch {
        // 同上
      }
    })();
  }, []);

  /* 轮询激活状态：只在 waiting 时跑 */
  useEffect(() => {
    if (!activation || poll?.status === "ok" || poll?.status === "cancelled") return;
    let stopped = false;
    const tick = async () => {
      try {
        const view = await apiGet<PollView>(
          `/api/sms/status?activationId=${encodeURIComponent(activation.activationId)}`,
        );
        if (stopped) return;
        setPoll(view);
        if (view.status === "ok" || view.status === "cancelled" || view.status === "expired") {
          stopped = true;
        }
        if (view.balanceUsd) {
          setSession((prev) => (prev ? { ...prev, balanceUsd: view.balanceUsd as string } : prev));
        }
      } catch {
        // 轮询失败静默重试
      }
    };
    void tick();
    const timer = setInterval(() => {
      if (stopped) {
        clearInterval(timer);
        return;
      }
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activation, poll?.status]);

  /* 取消倒计时以服务端返回的剩余秒数为准（刷新页面也不丢），本地每秒递减 */
  useEffect(() => {
    if (poll && Number.isFinite(poll.cancelAvailableInSeconds)) {
      setCancelLeft(poll.cancelAvailableInSeconds);
      setCancelTotal((prev) =>
        prev === null || poll.cancelAvailableInSeconds > prev ? poll.cancelAvailableInSeconds : prev,
      );
    }
  }, [poll]);

  const cancelTicking = cancelLeft !== null && cancelLeft > 0;
  useEffect(() => {
    if (!cancelTicking) return;
    const timer = setInterval(() => {
      setCancelLeft((prev) => (prev === null || prev <= 0 ? prev : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cancelTicking]);

  /* 倒计时未归零（或还没拿到服务端数据）时，取消按钮一律禁用 */
  const cancelPending = cancelLeft === null || cancelLeft > 0;

  const filteredServices = useMemo(() => {
    const needle = serviceFilter.trim().toLowerCase();
    const list = needle
      ? services.filter((item) => {
          const zh = displayServiceName(item.code, item.name).toLowerCase();
          return (
            item.code.toLowerCase().includes(needle) ||
            item.name.toLowerCase().includes(needle) ||
            zh.includes(needle)
          );
        })
      : services;
    /* 上游返回顺序每次都被打乱，展示前按展示名做确定性排序 */
    return [...list]
      .sort((a, b) => {
        const nameA = displayServiceName(a.code, a.name);
        const nameB = displayServiceName(b.code, b.name);
        return nameA.localeCompare(nameB, "zh-Hans-CN") || a.code.localeCompare(b.code);
      })
      .slice(0, 300);
  }, [services, serviceFilter]);

  const refreshMe = useCallback(async () => {
    const me = await apiGet<MeView>("/api/me/activations");
    if (me.key) {
      setSession((prev) =>
        prev
          ? { ...prev, balanceUsd: me.key?.balanceUsd ?? prev.balanceUsd, status: me.key?.status ?? prev.status }
          : prev,
      );
    }
    setNotice(`余额已刷新：${me.key?.balanceUsd ?? "0.00"} USD`);
  }, []);

  const quotePrice = useCallback(async () => {
    if (!service || !country) return;
    const seq = (quoteSeqRef.current += 1);
    try {
      const view = await apiGet<QuoteView>(
        `/api/sms/price?service=${encodeURIComponent(service)}&country=${encodeURIComponent(country)}`,
      );
      /* 丢弃过期响应：只有最新一次请求可以写状态 */
      if (seq !== quoteSeqRef.current) return;
      setQuote(view);
    } catch (error) {
      if (seq !== quoteSeqRef.current) return;
      throw error;
    }
  }, [service, country]);

  /* 国家 + 服务都选好 → ~400ms 防抖自动估价；按钮保留为手动刷新 */
  useEffect(() => {
    if (!service || !country) return;
    const timer = setTimeout(() => {
      void quotePrice().catch(() => {
        // 自动估价失败静默；用户可点「重新估价」重试
      });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [service, country, quotePrice]);

  const getNumber = useCallback(async () => {
    if (!service || !country) return;
    const view = await apiPost<ActivationView>("/api/sms/get", {
      service,
      country,
      maxPriceUsd: quote?.maxPriceUsd,
    });
    setActivation(view);
    setPoll(null);
    setCancelLeft(null);
    setCancelTotal(null);
    setNotice(`已取号 ${view.phone}，预扣 ${view.reservedUsd} USD，实际成本 ${view.costUsd} USD`);
  }, [service, country, quote?.maxPriceUsd]);

  const cancel = useCallback(async () => {
    if (!activation) return;
    try {
      const result = await apiPost<{ refundedUsd: string; balanceUsd: string | null }>("/api/sms/cancel", {
        activationId: activation.activationId,
      });
      setPoll((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
      setCancelLeft(0);
      setCancelTotal(null);
      if (result.balanceUsd) {
        setSession((prev) => (prev ? { ...prev, balanceUsd: result.balanceUsd as string } : prev));
      }
      setNotice(`已取消，回补 ${result.refundedUsd} USD`);
    } catch (error) {
      /* 服务端 409 带 retryAfterSeconds：重置倒计时 + 可读提示 */
      const retryAfter = retryAfterSecondsOf(error);
      if (retryAfter !== null) {
        setCancelLeft(retryAfter);
        setCancelTotal(retryAfter);
        setNotice(null);
      }
      throw error;
    }
  }, [activation]);

  /** 复制验证码：优先 Clipboard API，失败则兜底选中文本提示手抄。 */
  const copyCode = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice("浏览器拒绝了剪贴板访问，请手动选中复制");
    }
  }, []);

  const running = poll?.status === "waiting" || (!poll && activation !== null);

  const cancelLabel =
    busy === "cancel"
      ? "取消中…"
      : cancelPending && cancelLeft !== null
        ? `可取消倒计时 ${formatCountdown(cancelLeft)}`
        : "取消并回补";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">接码台</h1>
          <p className="muted">贴卡密 → 选国家 / 服务 → 估价 → 取号 → 每 4 秒自动轮询验证码。</p>
        </div>
        <span className="badge badge-info">实时扣费 · 取消回补</span>
      </header>

      {orderError ? (
        <div className="card" role="alert" style={{ borderColor: "rgb(var(--danger) / 0.4)" }}>
          <p className="text-sm" style={{ color: "rgb(var(--danger))" }}>
            查单失败：{orderError}
          </p>
        </div>
      ) : null}

      {order ? (
        <section className="card space-y-2 border-indigo-900 bg-indigo-950/30">
          <h2 className="text-sm font-semibold text-indigo-200">
            订单 {order.outTradeNo} · 面值 ${order.faceUsd} · {order.amountLdc} LDC · {order.status}
          </h2>
          {order.code ? (
            <div className="space-y-1">
              <p className="text-xs text-amber-300">卡密明文只在此窗口内展示，请立即保存（丢失无法找回）。</p>
              <code className="block select-all rounded-lg bg-slate-950 px-3 py-2 font-mono text-lg tracking-wider">
                {order.code}
              </code>
            </div>
          ) : order.codeExpired ? (
            <p className="muted">明文展示窗口已过，只剩前缀 {order.codePrefix}。如有疑问请联系卖家并提供订单号。</p>
          ) : (
            <p className="muted">支付尚未确认。稍后刷新本页，或到 LDC 收银台完成付款。</p>
          )}
          {order.warnings.length > 0 ? (
            <p className="text-xs text-amber-400">{order.warnings.join("；")}</p>
          ) : null}
        </section>
      ) : null}

      {!session ? (
        <section className="card card-lit space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="step-dot">1</span>
            贴入卡密进入接码台
          </h2>
          <input
            className="input code-display text-base"
            placeholder="GS-XXXX-XXXX-XXXX-XXXX"
            value={codeInput}
            onChange={(event) => setCodeInput(event.target.value)}
            autoComplete="off"
            aria-label="卡密"
          />
          <p className="faint">卡密只用于本站扣费；本站不会向第三方泄露你的卡密。</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy === "login" || codeInput.trim().length === 0}
            onClick={() => void run("login", async () => { await login(codeInput); })}
          >
            {busy === "login" ? "校验中…" : "进入接码台"}
          </button>
        </section>
      ) : (
        <>
          <section className="card card-lit">
            <div className="flex flex-wrap items-center justify-between gap-6">
              <div>
                <p className="faint">当前卡密</p>
                <p className="code-display mt-1 text-lg">{session.maskedCode}</p>
                <p className="faint mt-1">面值 ${session.faceUsd}</p>
              </div>
              <div
                className="rounded-2xl px-5 py-3 text-right"
                style={{
                  background: "rgb(var(--brand) / 0.1)",
                  border: "1px solid rgb(var(--brand) / 0.3)",
                }}
              >
                <p className="faint">可用余额</p>
                <p className="tnum mt-0.5 text-3xl font-semibold" style={{ color: "rgb(var(--brand))" }}>
                  ${session.balanceUsd}
                </p>
                <p className="faint">USD</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy === "me"}
                onClick={() => void run("me", refreshMe)}
              >
                {busy === "me" ? "刷新中…" : "刷新余额"}
              </button>
            </div>
          </section>

          <section className="card space-y-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <span className="step-dot">2</span>
              选国家 / 服务
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="country">
                  国家
                </label>
                <select
                  id="country"
                  className="input"
                  value={country}
                  onChange={(event) => {
                    setCountry(event.target.value);
                    setQuote(null);
                  }}
                >
                  <option value="">请选择…</option>
                  {countries.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.name ?? displayCountryName(item.eng, item.chn)}（#{item.id}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="serviceFilter">
                  服务（可搜索，支持中文 / 英文 / code）
                </label>
                <input
                  id="serviceFilter"
                  className="input mb-2"
                  placeholder="例如 telegram / 电报 / tg"
                  value={serviceFilter}
                  onChange={(event) => setServiceFilter(event.target.value)}
                />
                <select
                  className="input"
                  size={5}
                  value={service}
                  aria-label="服务"
                  onChange={(event) => {
                    setService(event.target.value);
                    setQuote(null);
                  }}
                >
                  {filteredServices.map((item) => (
                    <option key={item.code} value={item.code}>
                      {displayServiceName(item.code, item.name)}（{item.code}）
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!service || !country || busy === "get" || running}
                onClick={() => void run("get", getNumber)}
              >
                {busy === "get" ? "取号中…" : "获取号码"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!service || !country || busy === "quote"}
                onClick={() => void run("quote", quotePrice)}
              >
                {busy === "quote" ? "估价中…" : "重新估价"}
              </button>

              {quote ? (
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5"
                  style={{
                    background: "rgb(var(--surface-3) / 0.6)",
                    border: "1px solid rgb(var(--line) / var(--line-strong-a))",
                  }}
                >
                  <span className="faint">估价</span>
                  <span className="tnum text-sm font-medium" style={{ color: "rgb(var(--info))" }}>
                    {quote.priceUsd} USD
                  </span>
                  <span className="faint">（{quote.source}）</span>
                  {quote.available === null ? null : (
                    <span className="faint">· 可用 {quote.available}</span>
                  )}
                </div>
              ) : (
                <span className="faint">选好国家和服务后会自动估价</span>
              )}
            </div>
            {quote ? <p className="faint leading-relaxed">{quote.disclaimer}</p> : null}
          </section>
        </>
      )}

      {activation ? (
        <section className="card space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="step-dot">3</span>
            取号结果
          </h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="card-quiet">
              <p className="faint">号码</p>
              <p className="code-display mt-1 text-base">{activation.phone}</p>
            </div>
            <div className="card-quiet">
              <p className="faint">预扣上限</p>
              <p className="tnum mt-1 text-base">${activation.reservedUsd}</p>
            </div>
            <div className="card-quiet">
              <p className="faint">实际成本</p>
              <p className="tnum mt-1 text-base">${activation.costUsd}</p>
            </div>
          </div>

          {poll?.status === "ok" && poll.code ? (
            <div
              className="code-arrived space-y-2 rounded-xl p-4"
              style={{
                border: "1px solid rgb(var(--ok) / 0.45)",
                background: "rgb(var(--ok) / 0.1)",
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium" style={{ color: "rgb(var(--ok))" }}>
                  验证码已到达
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void copyCode(poll.code as string)}
                >
                  {copied ? "已复制 ✓" : "复制"}
                </button>
              </div>
              <p
                className="code-display select-all text-3xl"
                style={{ color: "rgb(var(--ok))" }}
                aria-live="polite"
              >
                {poll.code}
              </p>
              {poll.smsText ? (
                <p className="text-xs leading-relaxed" style={{ color: "rgb(var(--ok) / 0.8)" }}>
                  短信全文：{poll.smsText}
                </p>
              ) : null}
            </div>
          ) : poll?.status === "cancelled" ? (
            <p className="muted">已取消，余额已回补。</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 animate-pulse rounded-full"
                  style={{ background: "rgb(var(--info))" }}
                  aria-hidden="true"
                />
                <p className="muted">
                  等待短信…每 4 秒自动刷新{poll?.hint ? ` · ${poll.hint}` : ""}
                </p>
              </div>

              {cancelPending && cancelLeft !== null ? (
                <div className="space-y-1.5" aria-live="polite">
                  <div className="flex items-baseline justify-between">
                    <span className="faint">上游锁定中，暂不可取消</span>
                    <span className="tnum text-sm font-medium" style={{ color: "rgb(var(--warn))" }}>
                      {formatCountdown(cancelLeft)}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${
                          cancelTotal && cancelTotal > 0
                            ? Math.max(0, Math.min(100, ((cancelTotal - cancelLeft) / cancelTotal) * 100))
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {running && !poll?.code ? (
            <div className="space-y-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy === "cancel" || cancelPending}
                onClick={() => void run("cancel", cancel)}
              >
                {cancelLabel}
              </button>
              {cancelPending ? (
                <p className="faint">上游取号后约 60 秒内不允许取消，倒计时归零后按钮会自动启用。</p>
              ) : (
                <p className="faint">取消成功后，本次预扣金额会全额回补到卡密余额。</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {notice ? (
        <p
          className="text-sm"
          role="status"
          aria-live="polite"
          style={{ color: "rgb(var(--ok))" }}
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          className="card text-sm"
          role="alert"
          style={{ borderColor: "rgb(var(--danger) / 0.4)", color: "rgb(var(--danger))" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
