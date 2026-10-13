import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 后台「调整额度」必须同步面值。
 *
 * 回归：手动调额度只改了 balanceUsd，没动 faceUsd，
 * 于是后台出现「面值 $0.01 / 余额 $0.20」这种自相矛盾的展示
 * （维护者 2026-10-13 实测踩到，两张卡复现）。
 *
 * 这与之前"充值不累加面值"是同一类 bug —— 凡是改变余额的入口，
 * 都必须同步维护面值，否则展示与实际脱节。
 */
describe("调整额度：面值必须同步", () => {
  const src = readFileSync("src/app/api/admin/keys/action/route.ts", "utf8");

  it("adjust 分支同时更新 faceUsd", () => {
    const start = src.indexOf('if (body.action === "adjust")');
    const end = src.indexOf('if (body.action === "revoke")');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, end);
    expect(fn).toContain("faceUsd");
    expect(fn).toContain("tx.cardKey.update");
  });

  it("面值按 manual 净额同幅变动，保持「面值 = 余额 + 净消耗」不变量", () => {
    const start = src.indexOf('if (body.action === "adjust")');
    const end = src.indexOf('if (body.action === "revoke")');
    const fn = src.slice(start, end);
    /* 直接 plus(delta) 而不是取 max —— max 会破坏不变量，
       导致"扣了没退"的审计对合法卡误报 */
    expect(fn).toContain("dec(key.faceUsd.toString()).plus(delta)");
    expect(fn).not.toMatch(/lt\(newBalance\)/);
  });

  it("面值下限为 0（不出现负面值）", () => {
    const start = src.indexOf('if (body.action === "adjust")');
    const end = src.indexOf('if (body.action === "revoke")');
    const fn = src.slice(start, end);
    expect(fn).toMatch(/faceAfter/);
    expect(fn).toMatch(/lt\(0\)/);
  });

  it("写流水与改面值在同一事务里（要么都成，要么都不成）", () => {
    const start = src.indexOf('if (body.action === "adjust")');
    const end = src.indexOf('if (body.action === "revoke")');
    const fn = src.slice(start, end);
    expect(fn).toContain("$transaction");
  });
});
