"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AdminApiError,
  adminError,
  adminGet,
  adminLogin,
  adminLogout,
  adminPost,
  adminPut,
  checkAdminSession,
  downloadCsv,
} from "./_api";
import type {
  ActivationListView,
  IssueKeysView,
  KeyListView,
  LedgerListView,
  OrderListView,
  OverviewView,
  ReconcileView,
  SettingsView,
} from "./_types";

/* ==========================================================================
   通用小件
   ========================================================================== */

type Tone = "ok" | "warn" | "danger" | "info" | "plain";

function toneOf(status: string): Tone {
  switch (status) {
    case "active":
    case "paid":
    case "ok":
      return "ok";
    case "waiting":
    case "pending":
      return "warn";
    case "revoked":
    case "failed":
    case "cancelled":
    case "expired":
      return "danger";
    default:
      return "plain";
  }
}

function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: Tone }) {
  const cls = tone === "plain" ? "badge" : `badge badge-${tone}`;
  return <span className={cls}>{children}</span>;
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: Tone }) {
  const color =
    tone === "ok"
      ? "rgb(var(--ok))"
      : tone === "warn"
        ? "rgb(var(--warn))"
        : tone === "danger"
          ? "rgb(var(--danger))"
          : "rgb(var(--fg))";
  return (
    <div className="card-quiet">
      <p className="faint">{label}</p>
      <p className="tnum mt-1 text-xl font-semibold" style={{ color }}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal" style={{ color: "rgb(var(--fg-faint))" }}>{unit}</span> : null}
      </p>
    </div>
  );
}

function Alert({ children, tone = "danger" }: { children: React.ReactNode; tone?: Tone }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--danger)";
  return (
    <p
      role="alert"
      className="rounded-lg px-3 py-2 text-sm"
      style={{ background: `rgb(${color} / 0.1)`, border: `1px solid rgb(${color} / 0.4)`, color: `rgb(${color})` }}
    >
      {children}
    </p>
  );
}

function Pager({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (next: number) => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between text-xs" style={{ color: "rgb(var(--fg-muted))" }}>
      <span className="tnum">
        共 {total} 条 · 第 {page}/{totalPages} 页
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="faint py-6 text-center">{children}</p>;
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

/* ==========================================================================
   登录
   ========================================================================== */

function LoginCard({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await adminLogin(token.trim());
      onSuccess();
    } catch (caught) {
      setError(adminError(caught));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md pt-10">
      <div className="card card-lit space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">管理台</h1>
          <p className="muted">输入管理口令进入。口令只提交一次，之后用 HttpOnly Cookie 维持会话。</p>
        </div>
        <div>
          <label className="label" htmlFor="admin-token">
            管理口令
          </label>
          <input
            id="admin-token"
            className="input"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && token.trim()) void submit();
            }}
            placeholder="ADMIN_TOKEN"
          />
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy || token.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? "校验中…" : "进入"}
        </button>
        <p className="faint">口令同 IP 每分钟最多尝试 10 次，超过会临时锁定。</p>
      </div>
    </div>
  );
}

/* ==========================================================================
   设置
   ========================================================================== */

function SettingsTab({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* 表单字段用字符串存，避免受控数字输入的中间态问题 */
  const [rate, setRate] = useState("");
  const [markup, setMarkup] = useState("");
  const [lock, setLock] = useState("");
  const [retry, setRetry] = useState("");
  const [buffer, setBuffer] = useState("");
  const [presets, setPresets] = useState("");

  const apply = useCallback((data: SettingsView) => {
    setView(data);
    setRate(data.effective.rateLdcPerUsd);
    setMarkup(String(data.effective.markupPct));
    setLock(String(data.effective.cancelLockSeconds));
    setRetry(String(data.effective.cancelRetrySeconds));
    setBuffer(data.effective.safetyBufferUsd);
    setPresets(data.effective.faceValuePresets.join(", "));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        apply(await adminGet<SettingsView>("/api/admin/settings"));
      } catch (caught) {
        setError(adminError(caught));
      }
    })();
  }, [apply]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const list = presets
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const next = await adminPut<SettingsView>("/api/admin/settings", {
        rateLdcPerUsd: rate,
        markupPct: markup,
        cancelLockSeconds: lock,
        cancelRetrySeconds: retry,
        safetyBufferUsd: buffer,
        faceValuePresets: list,
      });
      apply(next);
      setNotice("已保存，站点即时生效（无需重新部署）");
      onSaved();
    } catch (caught) {
      setError(adminError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return error ? <Alert>{error}</Alert> : <Empty>加载中…</Empty>;
  }

  const fields: Array<{
    key: string;
    label: string;
    value: string;
    set: (v: string) => void;
    hint: string;
    fallback: string;
    touched: boolean;
  }> = [
    {
      key: "rate_ldc_per_usd",
      label: "汇率（1 美元 Grizzly 余额 → LDC）",
      value: rate,
      set: setRate,
      hint: view.hints.rateLdcPerUsd,
      fallback: view.envFallback.rateLdcPerUsd,
      touched: "rate_ldc_per_usd" in view.fromDb,
    },
    {
      key: "markup_pct",
      label: "附加毛利（%）",
      value: markup,
      set: setMarkup,
      hint: view.hints.markupPct,
      fallback: String(view.envFallback.markupPct),
      touched: "markup_pct" in view.fromDb,
    },
    {
      key: "cancel_lock_seconds",
      label: "取消锁定（秒）",
      value: lock,
      set: setLock,
      hint: view.hints.cancelLockSeconds,
      fallback: String(view.envFallback.cancelLockSeconds),
      touched: "cancel_lock_seconds" in view.fromDb,
    },
    {
      key: "cancel_retry_seconds",
      label: "取消失败重试锁（秒）",
      value: retry,
      set: setRetry,
      hint: view.hints.cancelRetrySeconds,
      fallback: String(view.envFallback.cancelRetrySeconds),
      touched: "cancel_retry_seconds" in view.fromDb,
    },
    {
      key: "safety_buffer_usd",
      label: "安全缓冲（USD）",
      value: buffer,
      set: setBuffer,
      hint: view.hints.safetyBufferUsd,
      fallback: view.envFallback.safetyBufferUsd,
      touched: "safety_buffer_usd" in view.fromDb,
    },
    {
      key: "face_value_presets",
      label: "首页面值档位（逗号分隔）",
      value: presets,
      set: setPresets,
      hint: view.hints.faceValuePresets,
      fallback: view.envFallback.faceValuePresets.join(", "),
      touched: "face_value_presets" in view.fromDb,
    },
  ];

  return (
    <div className="space-y-4">
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="ok">{notice}</Alert> : null}

      <div className="card space-y-5">
        <div>
          <h2 className="text-sm font-semibold">站点设置</h2>
          <p className="faint mt-1">
            这里的值存在数据库里，**优先于环境变量**，改完立即生效，不需要在 Vercel 重新部署。
          </p>
        </div>

        {fields.map((f) => (
          <div key={f.key}>
            <div className="flex items-baseline justify-between gap-3">
              <label className="label mb-0" htmlFor={`set-${f.key}`}>
                {f.label}
              </label>
              {f.touched ? (
                <Badge tone="info">已在后台覆盖</Badge>
              ) : (
                <span className="faint">未覆盖 · 用环境变量</span>
              )}
            </div>
            <input
              id={`set-${f.key}`}
              className="input tnum mt-1"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              inputMode="decimal"
            />
            <p className="faint mt-1">
              {f.hint} · 环境变量回退值：<span className="tnum">{f.fallback}</span>
            </p>
          </div>
        ))}

        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存设置"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void adminGet<SettingsView>("/api/admin/settings").then(apply).catch((e) => setError(adminError(e)))}
          >
            放弃修改
          </button>
        </div>
      </div>
    </div>
  );
}

/* ==========================================================================
   卡密
   ========================================================================== */

function KeysTab() {
  const [list, setList] = useState<KeyListView | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueKeysView | null>(null);

  const [faceUsd, setFaceUsd] = useState("1");
  const [count, setCount] = useState("1");
  const [note, setNote] = useState("");

  const load = useCallback(async (targetPage: number, status: string) => {
    try {
      const query = new URLSearchParams({ page: String(targetPage), pageSize: "20" });
      if (status) query.set("status", status);
      setList(await adminGet<KeyListView>(`/api/admin/keys?${query.toString()}`));
      setError(null);
    } catch (caught) {
      setError(adminError(caught));
    }
  }, []);

  useEffect(() => {
    void load(page, statusFilter);
  }, [load, page, statusFilter]);

  async function issue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setIssued(null);
    try {
      const result = await adminPost<IssueKeysView>("/api/admin/keys", {
        faceUsd,
        count: Number(count),
        note: note.trim() || undefined,
      });
      setIssued(result);
      setNotice(`已生成 ${result.keys.length} 张，合计面值 ${result.totalFaceUsd} USD`);
      setPage(1);
      await load(1, statusFilter);
    } catch (caught) {
      setError(adminError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "revoke" | "restore") {
    setError(null);
    setNotice(null);
    try {
      const result = await adminPost<{ status: string }>("/api/admin/keys/action", { id, action });
      setNotice(action === "revoke" ? `已作废，释放 ${(result as never as { releasedUsd: string }).releasedUsd} USD 池额度` : "已恢复");
      await load(page, statusFilter);
    } catch (caught) {
      setError(adminError(caught));
    }
  }

  /**
   * 手动调整卡密额度。
   *
   * 走 /api/admin/keys/action 的 adjust 分支，服务端用 ledger.manualAdjust
   * 写一条 reason="manual" 的流水 —— 这样余额变化有据可查，而且对账等式
   * 本来就会减去 manual 合计，不会凭空报差额。
   * 正数加、负数减，最多两位小数，单次上限 1000 USD。
   */
  async function adjust(id: string, codePrefix: string, current: string) {
    const input = window.prompt(
      `调整卡密 ${codePrefix} 的额度\n当前余额：${current} USD\n\n输入带符号的金额（如 0.5 表示加 0.5，-0.2 表示减 0.2）：`,
      "",
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) return;

    setError(null);
    setNotice(null);
    try {
      const result = await adminPost<{ deltaUsd: string; balanceUsd: string; notice: string }>(
        "/api/admin/keys/action",
        { id, action: "adjust", amountUsd: trimmed },
      );
      setNotice(result.notice);
      await load(page, statusFilter);
    } catch (caught) {
      setError(adminError(caught));
    }
  }

  return (
    <div className="space-y-4">
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="ok">{notice}</Alert> : null}

      <div className="card space-y-4">
        <h2 className="text-sm font-semibold">生成卡密</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="k-face">
              面值（USD）
            </label>
            <input id="k-face" className="input tnum" value={faceUsd} onChange={(e) => setFaceUsd(e.target.value)} inputMode="decimal" />
          </div>
          <div>
            <label className="label" htmlFor="k-count">
              数量
            </label>
            <input id="k-count" className="input tnum" value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="k-note">
              备注（可选）
            </label>
            <input id="k-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：给某位老哥预留" />
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void issue()}>
          {busy ? "生成中…" : "生成"}
        </button>
        <p className="faint">
          生成前会校验可用池（真实余额 − 已售未消耗 − 安全缓冲），不足会被拒绝并给出缺口。
        </p>
      </div>

      {issued ? (
        <div className="card space-y-3" style={{ borderColor: "rgb(var(--warn) / 0.45)" }}>
          <Alert tone="warn">{issued.notice}</Alert>
          <div className="space-y-1.5">
            {issued.keys.map((k) => (
              <p key={k.id} className="code-display select-all text-sm">
                {k.code}
              </p>
            ))}
          </div>
          <p className="faint">刷新或离开本页后无法再次查看明文，请立即保存。</p>
        </div>
      ) : null}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">卡密列表</h2>
          <div className="flex items-center gap-2">
            <select
              className="input btn-sm w-auto"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              aria-label="按状态筛选"
            >
              <option value="">全部状态</option>
              <option value="active">active</option>
              <option value="depleted">depleted</option>
              <option value="revoked">revoked</option>
              <option value="expired">expired</option>
            </select>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadCsv("keys")}>
              导出 CSV
            </button>
          </div>
        </div>

        {!list ? (
          <Empty>加载中…</Empty>
        ) : list.keys.length === 0 ? (
          <Empty>还没有卡密</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>前缀</th>
                    <th>面值</th>
                    <th>余额</th>
                    <th>状态</th>
                    <th>来源</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.keys.map((k) => (
                    <tr key={k.id}>
                      <td className="code-display">{k.codePrefix}</td>
                      <td className="tnum">${k.faceUsd}</td>
                      <td className="tnum">${k.balanceUsd}</td>
                      <td>
                        <Badge tone={toneOf(k.status)}>{k.status}</Badge>
                      </td>
                      <td className="faint">{k.outTradeNo ? `订单 ${k.outTradeNo.slice(0, 12)}…` : "后台生成"}</td>
                      <td className="faint">{shortTime(k.createdAt)}</td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          {/* 手动调额度：客服补偿/纠正错账用，写 manual 流水，对账不产生假差额 */}
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void adjust(k.id, k.codePrefix, String(k.balanceUsd))}
                          >
                            调整额度
                          </button>
                          {k.status === "revoked" ? (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(k.id, "restore")}>
                              恢复
                            </button>
                          ) : (
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => void act(k.id, "revoke")}>
                              作废
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={list.page} totalPages={list.totalPages} total={list.total} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   流水（订单 / 激活 / 账本）
   ========================================================================== */

type RecordKind = "orders" | "activations" | "ledger";

function RecordsTab() {
  const [kind, setKind] = useState<RecordKind>("orders");
  const [page, setPage] = useState(1);
  const [orders, setOrders] = useState<OrderListView | null>(null);
  const [activations, setActivations] = useState<ActivationListView | null>(null);
  const [ledger, setLedger] = useState<LedgerListView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const query = `?page=${page}&pageSize=20`;
        if (kind === "orders") setOrders(await adminGet<OrderListView>(`/api/admin/orders${query}`));
        if (kind === "activations") setActivations(await adminGet<ActivationListView>(`/api/admin/activations${query}`));
        if (kind === "ledger") setLedger(await adminGet<LedgerListView>(`/api/admin/ledger${query}`));
        setError(null);
      } catch (caught) {
        setError(adminError(caught));
      }
    })();
  }, [kind, page]);

  const current = kind === "orders" ? orders : kind === "activations" ? activations : ledger;

  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(
            [
              ["orders", "订单"],
              ["activations", "激活记录"],
              ["ledger", "余额流水"],
            ] as Array<[RecordKind, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={kind === key ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
              onClick={() => {
                setKind(key);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadCsv(kind)}>
          导出 CSV
        </button>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      {!current ? (
        <Empty>加载中…</Empty>
      ) : (
        <>
          <div className="overflow-x-auto">
            {kind === "orders" && orders ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>类型</th>
                    <th>名称</th>
                    <th>积分</th>
                    <th>面值</th>
                    <th>状态</th>
                    <th>卡密</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.orders.map((o) => (
                    <tr key={o.id}>
                      <td className="code-display text-xs">{o.outTradeNo.slice(0, 14)}…</td>
                      <td>
                        {/* 新购 vs 充值：不区分的话根本看不出这张卡是买的还是充的 */}
                        <Badge tone={o.kind === "topup" ? "info" : "ok"}>
                          {o.kind === "topup" ? "充值" : "买卡"}
                        </Badge>
                      </td>
                      <td>{o.name}</td>
                      <td className="tnum">{o.amountLdc}</td>
                      <td className="tnum">${o.faceUsd}</td>
                      <td>
                        <Badge tone={toneOf(o.status)}>{o.status}</Badge>
                      </td>
                      <td className="code-display text-xs">
                        {o.kind === "topup"
                          ? o.targetKeyPrefix
                            ? `${o.targetKeyPrefix}（充入）`
                            : "—"
                          : (o.keyPrefix ?? "—")}
                      </td>
                      <td className="faint">{shortTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {kind === "activations" && activations ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>卡密</th>
                    <th>服务</th>
                    <th>国家</th>
                    <th>号码</th>
                    <th>预扣</th>
                    <th>实扣</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {activations.activations.map((a) => (
                    <tr key={a.id}>
                      <td className="code-display text-xs">{a.keyPrefix ?? "—"}</td>
                      <td>{a.service}</td>
                      <td className="faint">{a.country}</td>
                      <td className="code-display text-xs">{a.phone}</td>
                      <td className="tnum">${a.reservedUsd}</td>
                      <td className="tnum">{a.costUsd ? `$${a.costUsd}` : "—"}</td>
                      <td>
                        <Badge tone={toneOf(a.status)}>{a.status}</Badge>
                      </td>
                      <td className="faint">{shortTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {kind === "ledger" && ledger ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>卡密</th>
                    <th>变动</th>
                    <th>变动后余额</th>
                    <th>原因</th>
                    <th>关联</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="code-display text-xs">{e.keyPrefix ?? "—"}</td>
                      <td
                        className="tnum"
                        style={{ color: Number(e.deltaUsd) < 0 ? "rgb(var(--danger))" : "rgb(var(--ok))" }}
                      >
                        {Number(e.deltaUsd) > 0 ? "+" : ""}
                        {e.deltaUsd}
                      </td>
                      <td className="tnum">${e.balanceAfter}</td>
                      <td className="faint">{e.reason}</td>
                      <td className="code-display text-xs">{e.refId ? `${e.refId.slice(0, 12)}…` : "—"}</td>
                      <td className="faint">{shortTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>

          {current.total === 0 ? <Empty>暂无记录</Empty> : null}
          <Pager page={current.page} totalPages={current.totalPages} total={current.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/* ==========================================================================
   概览与对账
   ========================================================================== */

function OverviewTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<OverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminGet<OverviewView>("/api/admin/overview"));
      setError(null);
    } catch (caught) {
      setError(adminError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function reconcile() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminPost<ReconcileView>("/api/admin/reconcile", {});
      setNotice(
        result.ok
          ? `核对一致：上游 ${result.realUsd}，本地推算 ${result.ledgerUsd}，差额 ${result.driftUsd}`
          : `合计差 ${result.driftUsd} USD：${result.message ?? "请检查"}`,
      );
      await load();
    } catch (caught) {
      setError(adminError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function calibrate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminPut<{ baselineUsd: string; driftBefore: string; notice: string }>(
        "/api/admin/reconcile",
        {},
      );
      setNotice(`已把差额 ${result.driftBefore} USD 并入基准（新基准 ${result.baselineUsd}）`);
      await load();
    } catch (caught) {
      setError(adminError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <Empty>加载中…</Empty>;

  return (
    <div className="space-y-4">
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone={notice.startsWith("核对一致") || notice.startsWith("已把差额") ? "ok" : "warn"}>{notice}</Alert> : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="上游真实余额"
              value={`$${data.pool.realBalanceUsd}`}
              unit="USD"
              tone={data.pool.degraded ? "warn" : "ok"}
            />
            <Stat label="已售未消耗（占用池）" value={`$${data.pool.allocatedUsd}`} unit="USD" />
            <Stat label="安全缓冲" value={`$${data.pool.safetyBufferUsd}`} unit="USD" />
            <Stat label="可用实时池" value={`$${data.pool.availableUsd}`} unit="USD" tone="ok" />
          </div>

          <div className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">余额核对</h2>
                <p className="faint mt-1">
                  本地应有余额 = 基准投入 − 净消耗 − 手工调整；差额 = 上游真实 − 本地应有。
                  数据源：{data.pool.source}
                  {data.pool.degraded ? "（已降级，用的是快照）" : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void calibrate()}
                  title="把当前差额并入基准，使对账归零。只改基准，不动任何卡密余额与流水。"
                >
                  {busy ? "处理中…" : "校准差额"}
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void reconcile()}>
                  {busy ? "核对中…" : "立即核对"}
                </button>
              </div>
            </div>
            <p className="faint tnum">
              净消耗 ${data.ledger.netConsumedUsd} · 手工 ${data.ledger.manualAdjustedUsd} · 卡密 {data.cards.total} 张 · 订单 {data.orders.total} 单（已付{" "}
              {data.orders.paidAmountLdc} LDC / ${data.orders.paidFaceUsd}）· 激活 {data.activations.total} 次
            </p>
            {/*
              未退款审计：扣了费但没退钱的激活。
              核账会自动补退能自动退的，这里显示的是"补退之后仍然对不上"的，
              count = 0 才是健康状态。
            */}
            {data.unrefunded && data.unrefunded.count > 0 ? (
              <div
                className="space-y-2 rounded-lg p-3"
                style={{
                  border: "1px solid rgb(var(--danger) / 0.4)",
                  background: "rgb(var(--danger) / 0.07)",
                }}
                role="alert"
              >
                <h3 className="text-sm font-medium" style={{ color: "rgb(var(--danger))" }}>
                  有 {data.unrefunded.count} 笔激活扣了费没退款（合计 ${data.unrefunded.totalOwedUsd}）
                </h3>
                <p className="text-xs leading-relaxed" style={{ color: "rgb(var(--fg-muted))" }}>
                  这些是核账自动处理后仍未退干净的，请人工核对。
                  可用上方「调整额度」给对应卡密手工补回。
                </p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="faint text-left">
                      <th className="py-1 pr-2">卡密</th>
                      <th className="py-1 pr-2">服务/国家</th>
                      <th className="py-1 pr-2">号码</th>
                      <th className="py-1 pr-2">状态</th>
                      <th className="py-1 pr-2">欠款</th>
                      <th className="py-1">已过</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unrefunded.items.map((u) => (
                      <tr key={u.activationId} style={{ borderTop: "1px solid rgb(var(--line) / 0.5)" }}>
                        <td className="code-display py-1 pr-2">{u.keyPrefix}</td>
                        <td className="py-1 pr-2">{u.service}/{u.country}</td>
                        <td className="code-display py-1 pr-2">{u.phone}</td>
                        <td className="py-1 pr-2">{u.status}</td>
                        <td className="tnum py-1 pr-2" style={{ color: "rgb(var(--danger))" }}>
                          ${u.owedUsd}
                        </td>
                        <td className="faint py-1">{u.ageMinutes} 分</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="faint text-xs">未退款审计：无异常（核账未发现扣费未退的激活）</p>
            )}

            {data.lastReconcile ? (
              <p className="faint">
                上次对账：{shortTime(data.lastReconcile.createdAt)} ·{" "}
                {data.lastReconcile.ok ? "通过" : "有偏差"} · 偏差 ${data.lastReconcile.driftUsd}
              </p>
            ) : (
              <p className="faint">还没有对账记录，建议点一次「立即对账」。</p>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card space-y-2">
              <h2 className="text-sm font-semibold">最近订单</h2>
              {data.recentOrders.length === 0 ? (
                <Empty>暂无订单</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>订单号</th>
                      <th>面值</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentOrders.map((o) => (
                      <tr key={o.id}>
                        <td className="code-display text-xs">{o.outTradeNo.slice(0, 12)}…</td>
                        <td className="tnum">${o.faceUsd}</td>
                        <td>
                          <Badge tone={toneOf(o.status)}>{o.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card space-y-2">
              <h2 className="text-sm font-semibold">最近激活</h2>
              {data.recentActivations.length === 0 ? (
                <Empty>暂无激活</Empty>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>号码</th>
                      <th>服务</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentActivations.map((a) => (
                      <tr key={a.id}>
                        <td className="code-display text-xs">{a.phone}</td>
                        <td className="faint">{a.service}</td>
                        <td>
                          <Badge tone={toneOf(a.status)}>{a.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   页面骨架
   ========================================================================== */

type TabKey = "overview" | "keys" | "records" | "settings";

const TABS: Array<[TabKey, string]> = [
  ["overview", "概览 / 对账"],
  ["keys", "卡密管理"],
  ["records", "订单与流水"],
  ["settings", "设置"],
];

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        setAuthed(await checkAdminSession());
      } catch (caught) {
        setBootError(adminError(caught));
        setAuthed(false);
      }
    })();
  }, []);

  if (authed === null) {
    return (
      <div className="pt-10">
        <Empty>正在检查登录状态…</Empty>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="space-y-4">
        {bootError ? (
          <div className="mx-auto max-w-md">
            <Alert>{bootError}</Alert>
          </div>
        ) : null}
        <LoginCard onSuccess={() => setAuthed(true)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">管理台</h1>
          <p className="muted">设置、卡密、订单与对账，全部走原子账本。</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            void adminLogout().then(() => {
              setAuthed(false);
            })
          }
        >
          退出登录
        </button>
      </header>

      <nav className="flex flex-wrap gap-1">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
            onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" ? <OverviewTab key="overview" refreshKey={refreshKey} /> : null}
      {tab === "keys" ? <KeysTab key="keys" /> : null}
      {tab === "records" ? <RecordsTab key="records" /> : null}
      {tab === "settings" ? <SettingsTab key="settings" onSaved={() => setRefreshKey((n) => n + 1)} /> : null}
    </div>
  );
}
