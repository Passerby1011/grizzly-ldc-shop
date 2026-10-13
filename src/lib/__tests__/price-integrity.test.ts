import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 价格完整性：客户端不得影响成交价，更不得污染全局价格缓存。
 *
 * 历史漏洞（高危，2026-10-13 审计发现并修复）：
 *   /api/sms/get 接受 maxPriceUsd → 直通 startActivation 的 priceUsd 覆盖分支
 *   → 调用者自己决定扣多少钱 → 取号成功后 observe() 把它写进全局 PriceCache
 *   → PriceCache 按 (service,country) 唯一且是唯一生效的价格来源
 *     （上游 getPrices 恒返回 BAD_ACTION）
 *   → 任何人用一张自己的卡就能永久改写某组合的售价，再取消拿回本金。
 *
 * 影响面是所有后续买家的资金，因此这几条断言必须常驻。
 */
describe("价格完整性：公开接口不得接受客户端定价", () => {
  const getRoute = readFileSync("src/app/api/sms/get/route.ts", "utf8");
  const service = readFileSync("src/lib/service.ts", "utf8");

  it("/api/sms/get 的 body schema 不含任何价格字段", () => {
    const schemaStart = getRoute.indexOf("const BodySchema");
    const schemaEnd = getRoute.indexOf("});", schemaStart);
    const schema = getRoute.slice(schemaStart, schemaEnd);
    expect(schema).not.toMatch(/maxPrice|priceUsd|price/i);
  });

  it("/api/sms/get 不向 startActivation 传 priceUsd", () => {
    const call = getRoute.slice(getRoute.indexOf("startActivation({"));
    expect(call.slice(0, 300)).not.toContain("priceUsd");
  });

  it("observe() 跳过 override 来源的价格（绝不把调用方数字写进全局缓存）", () => {
    expect(service).toContain('if (quote.source !== "override")');
    /* observe 必须在这个条件之内 */
    const guard = service.indexOf('if (quote.source !== "override")');
    const observe = service.indexOf("getPriceProvider().observe(", guard);
    expect(observe).toBeGreaterThan(guard);
  });

  it("唯一能触发 override 的入口不接受外部价格（全仓库只有内部调用）", () => {
    /* 仅 service.ts 内部构造 override，HTTP 路由一律不传 */
    const routeWithPrice = /priceUsd:\s*(body|req|request|params)/;
    for (const f of ["src/app/api/sms/get/route.ts", "src/app/api/sms/price/route.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(routeWithPrice);
    }
  });
});
