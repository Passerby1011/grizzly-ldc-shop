"use client";

import { useCallback, useEffect, useState } from "react";
import { adminError, adminGet, adminPost } from "./_api";
import type { IssueKeysView, KeyListView, OverviewView, ReconcileView } from "./_types";

const STORAGE_KEY = "glc_admin_token";

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [keys, setKeys] = useState<KeyListView | null>(null);
  const [issued, setIssued] = useState<IssueKeysView | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileView | null>(null);
  const [faceUsd, setFaceUsd] = useState("1");
  const [count, setCount] = useState("1");

  const run = useCallback(async (tag: string, fn: (token: string) => Promise<void>) => {
    setBusy(tag);
    setError(null);
    try {
      await fn(token);
    } catch (caught) {
      setError(adminError(caught));
      setAuthed(false);
    } finally {
      setBusy(null);
    }
  }, [token]);

  const loadAll = useCallback(
    async (activeToken: string) => {
      const data = await adminGet<OverviewView>(activeToken, "/api/admin/overview");
      setOverview(data);
      const list = await adminGet<KeyListView>(activeToken, "/api/admin/keys?limit=30");
      setKeys(list);
      setAuthed(true);
    },
    [],
  );

  useEffect(() => {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      setToken(saved);
      void loadAll(saved).catch((caught) => setError(adminError(caught)));
    }
  }, [loadAll]);

  const enter = useCallback(async () => {
    await run("enter", async (activeToken) => {
      window.sessionStorage.setItem(STORAGE_KEY, activeToken);
      await loadAll(activeToken);
    });
  }, [run, loadAll]);

  const refresh = useCallback(() => run("refresh", loadAll), [run, loadAll]);

  const issue = useCallback(
    () =>
      run("issue", async (activeToken) => {
        const data = await adminPost<IssueKeysView>(activeToken, "/api/admin/keys", {
          faceUsd: Number(faceUsd),
          count: Number(count),
        });
        setIssued(data);
        const list = await adminGet<KeyListView>(activeToken, "/api/admin/keys?limit=30");
        setKeys(list);
      }),
    [run, faceUsd, count],
  );

  const doReconcile = useCallback(
    () =>
      run("reconcile", async (activeToken) => {
        const data = await adminPost<ReconcileView>(activeToken, "/api/admin/reconcile");
        setReconcile(data);
        const fresh = await adminGet<OverviewView>(activeToken, "/api/admin/overview");
        setOverview(fresh);
      }),
    [run],
  );

  if (!authed) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">管理台</h1>
        <section className="card space-y-3">
          <label className="label" htmlFor="admin-token">
            管理口令（ADMIN_TOKEN）
          </label>
          <input
            id="admin-token"
            type="password"
            className="input"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void enter();
            }}
          />
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy === "enter" || token.length === 0}
            onClick={() => void enter()}
          >
            {busy === "enter" ? "校验中…" : "进入"}
          </button>
          <p className="text-xs text-slate-500">
            口令只存在浏览器 sessionStorage，随请求头 `Authorization: Bearer` 发送。
          </p>
        </section>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">管理台</h1>
        <button type="button" className="btn btn-ghost" disabled={busy === "refresh"} onClick={() => void refresh()}>
          {busy === "refresh" ? "刷新中…" : "刷新"}
        </button>
      </div>

      {overview ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Grizzly 真实余额" value={`$${overview.pool.realBalanceUsd}`} hint={overview.pool.source} />
            <Stat label="已售未消耗" value={`$${overview.pool.allocatedUsd}`} hint="active 卡密余额之和" />
            <Stat
              label="可用实时池"
              value={`$${overview.pool.availableUsd}`}
              hint={`缓冲 $${overview.pool.safetyBufferUsd}`}
              danger={Number(overview.pool.availableUsd) < 0}
            />
            <Stat label="历史已消耗" value={`$${overview.ledger.consumedUsd}`} hint="流水负向合计" />
          </section>

          <section className="grid gap-4 sm:grid-cols-3">
            <Stat label="卡密" value={String(overview.cards.total)} hint={summarize(overview.cards.byStatus)} />
            <Stat label="订单" value={String(overview.orders.total)} hint={summarize(overview.orders.byStatus)} />
            <Stat
              label="激活"
              value={String(overview.activations.total)}
              hint={summarize(overview.activations.byStatus)}
            />
          </section>

          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">对账</h2>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy === "reconcile"}
                onClick={() => void doReconcile()}
              >
                {busy === "reconcile" ? "对账中…" : "立即对账"}
              </button>
            </div>
            {reconcile ? (
              <p className={reconcile.ok ? "muted" : "text-sm text-rose-400"}>
                真实 ${reconcile.realUsd} · 账本 ${reconcile.ledgerUsd} · 漂移 ${reconcile.driftUsd}
                {reconcile.message ? ` · ${reconcile.message}` : " · 一致"}
              </p>
            ) : overview.lastReconcile ? (
              <p className={overview.lastReconcile.ok ? "muted" : "text-sm text-rose-400"}>
                最近一次（{new Date(overview.lastReconcile.createdAt).toLocaleString()}）：真实 $
                {overview.lastReconcile.realUsd} · 账本 ${overview.lastReconcile.ledgerUsd} · 漂移 $
                {overview.lastReconcile.driftUsd}
                {overview.lastReconcile.message ? ` · ${overview.lastReconcile.message}` : " · 一致"}
              </p>
            ) : (
              <p className="muted">还没有对账记录。</p>
            )}
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">发卡密</h2>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label" htmlFor="face">
                  面值 USD
                </label>
                <input
                  id="face"
                  className="input w-28"
                  value={faceUsd}
                  onChange={(event) => setFaceUsd(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="count">
                  数量
                </label>
                <input
                  id="count"
                  className="input w-24"
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
              </div>
              <button type="button" className="btn btn-primary" disabled={busy === "issue"} onClick={() => void issue()}>
                {busy === "issue" ? "生成中…" : "生成卡密"}
              </button>
            </div>
            {issued ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-300">
                  共 ${issued.totalFaceUsd} · {issued.notice}
                </p>
                <ul className="space-y-1">
                  {issued.keys.map((key) => (
                    <li key={key.id} className="flex items-center gap-2">
                      <code className="select-all rounded bg-slate-950 px-2 py-1 font-mono">{key.code}</code>
                      <span className="text-xs text-slate-500">${key.faceUsd}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">最近卡密（不含明文）</h2>
            <Table
              head={["前缀", "面值", "余额", "状态", "关联订单", "创建时间"]}
              rows={(keys?.keys ?? []).map((key) => [
                key.codePrefix,
                `$${key.faceUsd}`,
                `$${key.balanceUsd}`,
                key.status,
                key.outTradeNo ?? "—",
                new Date(key.createdAt).toLocaleString(),
              ])}
            />
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">最近订单</h2>
            <Table
              head={["订单号", "面值", "金额 LDC", "状态", "创建时间"]}
              rows={overview.recentOrders.map((order) => [
                order.outTradeNo,
                `$${order.faceUsd}`,
                order.amountLdc,
                order.status,
                new Date(order.createdAt).toLocaleString(),
              ])}
            />
          </section>

          <section className="card space-y-3">
            <h2 className="text-sm font-semibold">最近激活</h2>
            <Table
              head={["服务", "国家", "号码", "状态", "验证码", "成本", "创建时间"]}
              rows={overview.recentActivations.map((item) => [
                item.service,
                item.country,
                item.phone,
                item.status,
                item.code ?? "—",
                item.costUsd ? `$${item.costUsd}` : "—",
                new Date(item.createdAt).toLocaleString(),
              ])}
            />
          </section>
        </>
      ) : (
        <p className="muted">加载中…</p>
      )}

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
    </div>
  );
}

function summarize(byStatus: Record<string, number>): string {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return "暂无";
  return entries.map(([status, value]) => `${status} ${value}`).join(" · ");
}

function Stat({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <div className="card">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={danger ? "mt-1 text-2xl font-semibold text-rose-400" : "mt-1 text-2xl font-semibold"}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="muted">暂无数据。</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
            {head.map((cell) => (
              <th key={cell} className="py-2 pr-4 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-slate-900/60">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2 pr-4 font-mono text-xs text-slate-300">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
