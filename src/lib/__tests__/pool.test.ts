import { describe, expect, it } from "vitest";
import {
  clampNonNegative,
  computeAvailableUsd,
  DEFAULT_SAFETY_BUFFER_USD,
  PoolExhaustedError,
  resolveSafetyBufferUsd,
} from "../pool";

describe("computeAvailableUsd（可用 = 真实 − 已售未消耗 − 缓冲）", () => {
  it("正常情况", () => {
    expect(computeAvailableUsd("10", "4.5", "0.5").toFixed(2)).toBe("5.00");
  });

  it("超卖时返回负数，绝不悄悄夹成 0", () => {
    expect(computeAvailableUsd("1", "5", "0.5").toFixed(2)).toBe("-4.50");
  });

  it("边界：全 0", () => {
    expect(computeAvailableUsd("0", "0", "0").toFixed(2)).toBe("0.00");
  });

  it("刚好卖光", () => {
    expect(computeAvailableUsd("5", "4.5", "0.5").toFixed(2)).toBe("0.00");
  });

  it("Decimal 运算不带浮点误差", () => {
    expect(computeAvailableUsd("0.3", "0.1", "0.2").toFixed(4)).toBe("0.0000");
  });
});

describe("clampNonNegative（只用于展示）", () => {
  it("负数归零，正数原样", () => {
    expect(clampNonNegative("-4.50").toFixed(2)).toBe("0.00");
    expect(clampNonNegative("3").toFixed(2)).toBe("3.00");
  });
});

describe("PoolExhaustedError", () => {
  it("报告需要多少、可用多少、还差多少", () => {
    const error = new PoolExhaustedError("5.00", "2.00");
    expect(error.requiredUsd.toFixed(2)).toBe("5.00");
    expect(error.availableUsd.toFixed(2)).toBe("2.00");
    expect(error.shortfallUsd.toFixed(2)).toBe("3.00");
    expect(error.message).toContain("可用池不足");
  });
});

describe("resolveSafetyBufferUsd", () => {
  it("显式覆盖优先", () => {
    expect(resolveSafetyBufferUsd("1.25").toFixed(2)).toBe("1.25");
  });

  it("没有覆盖时回落到环境变量或默认值，且一定是合法金额", () => {
    const value = resolveSafetyBufferUsd();
    expect(value.gte(0)).toBe(true);
    expect(value.isFinite()).toBe(true);
    expect(DEFAULT_SAFETY_BUFFER_USD).toBe("0.50");
  });
});
