/**
 * 后台路由的鉴权一致性。
 *
 * 为什么要有这个测试：后台页面走 HttpOnly Cookie，服务端 `requireAdmin` 同时支持
 * Cookie 与 Bearer。曾经踩过的坑是「页面改了走 Cookie，但个别老接口还在只用
 * requireBearer（只认请求头）」→ 那些接口在页面上必然 401，报「管理口令错误」。
 *
 * 这里用源码级断言把这个约束钉死：/api/admin/** 下**不允许**再出现 requireBearer。
 * 只有 /api/cron/** 才该用 Bearer（它靠 CRON_SECRET，没有登录态）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(__dirname, "..", "..", "app", "api");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const routes = walk(API_ROOT);

describe("后台路由鉴权一致性", () => {
  it("能找到路由文件（防止路径写错导致测试空转）", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("/api/admin/** 一律不得使用 requireBearer", () => {
    const offenders = routes
      .filter((file) => file.includes(`${join("api", "admin")}`))
      .filter((file) => readFileSync(file, "utf8").includes("requireBearer"));
    expect(
      offenders.map((f) => f.split(/[\\/]/).slice(-4).join("/")),
      "这些后台路由只认请求头，页面走 Cookie 会 401；应改用 requireAdmin",
    ).toEqual([]);
  });

  it("/api/admin/** 每个 route.ts 都必须有鉴权（不允许裸奔）", () => {
    const adminRoutes = routes.filter((file) => file.includes(`${join("api", "admin")}`));
    const naked = adminRoutes.filter((file) => {
      const src = readFileSync(file, "utf8");
      /* login/logout 本身就是鉴权入口，不需要先鉴权 */
      const isAuthEntry = /admin[\\/](login|logout)[\\/]route\.ts$/.test(file);
      return !isAuthEntry && !src.includes("requireAdmin");
    });
    expect(
      naked.map((f) => f.split(/[\\/]/).slice(-4).join("/")),
      "后台路由必须调用 requireAdmin",
    ).toEqual([]);
  });

  it("/api/cron/** 保留 Bearer（它没有登录态，靠 CRON_SECRET）", () => {
    const cronRoutes = routes.filter((file) => file.includes(`${join("api", "cron")}`));
    expect(cronRoutes.length).toBeGreaterThan(0);
    for (const file of cronRoutes) {
      expect(readFileSync(file, "utf8")).toContain("requireBearer");
    }
  });
});
