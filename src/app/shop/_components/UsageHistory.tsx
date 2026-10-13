"use client";

import { useState } from "react";
import type { MeView } from "../_types";

/** 状态 → 中文标签 + 色调用 */
function statusLabel(status: string): { text: string; tone: string } {
  switch (status) {
    case "ok":
      return { text: "已收到码", tone: "ok" };
    case "waiting":
      return { text: "等待中", tone: "warn" };
    case "cancelled":
      return { text: "已取消（已回补）", tone: "info" };
    case "expired":
      return { text: "超时回收", tone: "danger" };
    default:
      return { text: status, tone: "plain" };
  }
}

/** 流水原因 → 中文说明 */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "reserve":
      return "发卡入账";
    case "topup":
      return "充值";
    case "get_number":
      return "取号扣费";
    case "cancel_refund":
      return "取消回补";
    case "adjust_reserve":
      return "额度调整";
    case "manual":
      return "人工调整";
    default:
      return reason;
  }
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * 卡密使用历史：取号记录 + 资金流水。
 *
 * 为什么要有：以前买家刷新页面就什么都看不到了，连"我这张卡花过哪些钱"
 * 都查无对证（维护者 2026-10-11 明确要求可见）。数据全部来自
 * GET /api/me/activations，按 HttpOnly Cookie 会话取，不依赖任何前端状态。
 */
export function UsageHistory({ me, onRefresh }: { me: MeView | null; onRefresh: () => void }) {
  const [tab, setTab] = useState<"activations" | "ledger">("activations");

  if (!me) {
    return (
      <section className="card space-y-2">
        <h2 className="text-sm font-semibold">使用历史</h2>
        <p className="faint">加载中…</p>
      </section>
    );
  }

  const acts = me.activations;
  const led = me.ledger;
  const okCount = acts.filter((a) => a.status === "ok").length;
  const spent = acts.reduce((sum, a) => sum + (a.status === "ok" ? Number(a.costUsd ?? 0) : 0), 0);

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span className="step-dot">4</span>
          使用历史
        </h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          刷新
        </button>
      </div>

      {/* 概览：让买家一眼看到"我用过几次、花了多少" */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card-quiet">
          <p className="faint">取号次数</p>
          <p className="tnum mt-1 text-base">{acts.length} 次</p>
        </div>
        <div className="card-quiet">
          <p className="faint">成功收到码</p>
          <p className="tnum mt-1 text-base">{okCount} 次</p>
        </div>
        <div className="card-quiet">
          <p className="faint">累计消费</p>
          <p className="tnum mt-1 text-base">${spent.toFixed(2)}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className={tab === "activations" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() => setTab("activations")}
        >
          取号记录（{acts.length}）
        </button>
        <button
          type="button"
          className={tab === "ledger" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
          onClick={() => setTab("ledger")}
        >
          资金流水（{led.length}）
        </button>
      </div>

      {tab === "activations" ? (
        acts.length === 0 ? (
          <p className="faint">还没有取号记录。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="faint text-left">
                  <th className="py-2 pr-3">服务 / 国家</th>
                  <th className="py-2 pr-3">号码</th>
                  <th className="py-2 pr-3">验证码</th>
                  <th className="py-2 pr-3">费用</th>
                  <th className="py-2 pr-3">状态</th>
                  <th className="py-2">时间</th>
                </tr>
              </thead>
              <tbody>
                {acts.map((a) => {
                  const st = statusLabel(a.status);
                  return (
                    <tr key={a.id} style={{ borderTop: "1px solid rgb(var(--line) / 0.5)" }}>
                      <td className="py-2 pr-3">
                        <span className="code-display text-xs">{a.service}</span>
                        <span className="faint"> · {a.country}</span>
                      </td>
                      <td className="code-display py-2 pr-3 text-xs">{a.phone}</td>
                      <td className="code-display py-2 pr-3 text-xs">
                        {a.status === "ok" && a.code ? (
                          <span style={{ color: "rgb(var(--ok))" }}>{a.code}</span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="tnum py-2 pr-3">${a.costUsd ?? "0.00"}</td>
                      <td className="py-2 pr-3">
                        <span className={`badge badge-${st.tone}`}>{st.text}</span>
                      </td>
                      <td className="faint py-2">{shortTime(a.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : led.length === 0 ? (
        <p className="faint">还没有资金流水。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="faint text-left">
                <th className="py-2 pr-3">事项</th>
                <th className="py-2 pr-3">变动</th>
                <th className="py-2 pr-3">余额</th>
                <th className="py-2">时间</th>
              </tr>
            </thead>
            <tbody>
              {led.map((l) => {
                const delta = Number(l.deltaUsd);
                return (
                  <tr key={l.id} style={{ borderTop: "1px solid rgb(var(--line) / 0.5)" }}>
                    <td className="py-2 pr-3">{reasonLabel(l.reason)}</td>
                    <td
                      className="tnum py-2 pr-3"
                      style={{ color: delta >= 0 ? "rgb(var(--ok))" : "rgb(var(--danger))" }}
                    >
                      {delta >= 0 ? "+" : ""}
                      ${l.deltaUsd}
                    </td>
                    <td className="tnum py-2 pr-3 faint">${l.balanceAfter}</td>
                    <td className="faint py-2">{shortTime(l.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
