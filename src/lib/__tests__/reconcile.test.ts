import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 对账等式的口径正确性。
 *
 * 旧公式 drift = 真实 − (已售未消耗 + 历史消耗) 是错的：
 * 「已售未消耗」统计的是 active 卡密的余额，作废一张卡它就变，
 * 而上游余额根本不会变 —— 于是手动作废一张卡，对账就凭空多出差额
 * （实测差 1.74，老板截图里那条告警）。
 *
 * 新公式只认「真正打到上游的变动」：
 *   应有余额 = 基准投入 − 净消耗 − 手工调整
 *   净消耗   = 取号预扣 − 退回差额 − 取消回补
 * 发卡 / 充值入账 / 作废 / 恢复 都不进等式。
 */
describe("对账等式：只认真正打到上游的变动", () => {
  const src = readFileSync("src/lib/pool.ts", "utf8");

  it("净消耗只统计取号与退回三类原因", () => {
    const fn = src.slice(src.indexOf("export async function getNetConsumedUsd"), src.indexOf("export async function getManualAdjustedUsd"));
    expect(fn).toContain('["get_number", "adjust_reserve", "cancel_refund"]');
    /* 发卡入账 / 充值 / 手工调整绝不能进净消耗 */
    expect(fn).not.toContain('"reserve"');
    expect(fn).not.toContain('"topup"');
    expect(fn).not.toContain('"manual"');
  });

  it("手工调整单列，不混进净消耗", () => {
    expect(src).toContain("export async function getManualAdjustedUsd");
    const fn = src.slice(src.indexOf("export async function getManualAdjustedUsd"));
    expect(fn.slice(0, 400)).toContain('reason: "manual"');
  });

  it("对账等式是 基准 − 净消耗 − 手工调整（不再减「已售未消耗」）", () => {
    const fn = src.slice(src.indexOf("export async function runReconcile"));
    expect(fn).toContain("baselineUsd.minus(netConsumed).minus(manualAdjusted)");
    /* 旧口径的痕迹必须消失：不得再拿 allocatedUsd 参与减法 */
    expect(fn.slice(0, 1200)).not.toContain("pool.realBalanceUsd.minus(ledgerUsd)");
  });

  it("作废卡密不进对账等式 —— 它连流水都不产生", () => {
    /* 作废走的是 keys/action 路由，只改 status 与 poolReservation */
    const action = readFileSync("src/app/api/admin/keys/action/route.ts", "utf8");
    expect(action).toContain('status: "revoked"');
    /* 不得写 KeyLedger（若写了就会污染净消耗） */
    expect(action).not.toContain("keyLedger");
  });

  it("校准只改基准，不动卡密余额与流水", () => {
    const start = src.indexOf("export async function calibrateBaseline");
    const fn = src.slice(start, src.indexOf("export interface IssueCardKeysInput"));
    expect(fn).toContain("reconcileBaseline.upsert");
    expect(fn).not.toContain("cardKey");
    expect(fn).not.toContain("keyLedger");
  });

  it("基准表缺失时降级不抛错（线上忘记迁移也不能挂）", () => {
    const fn = src.slice(src.indexOf("export async function ensureReconcileBaseline"), src.indexOf("export async function runReconcile"));
    expect(fn).toContain("tableMissing: true");
    expect(fn).toContain("catch");
  });
});
