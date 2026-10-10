import { describe, expect, it } from "vitest";
import {
  dec,
  effectiveLdcRate,
  formatUsd,
  ldcToUsd,
  parseAmountInput,
  round2,
  roundDown2,
  roundUp2,
  sumDecimals,
  toStorageString,
  usdToLdc,
} from "../money";

describe("roundUp2（向上取整到 2 位小数）", () => {
  it("0 还是 0", () => {
    expect(roundUp2(0).toFixed(2)).toBe("0.00");
  });

  it("极小值只要大于 0 就进位到 0.01", () => {
    expect(roundUp2("0.0001").toFixed(2)).toBe("0.01");
    expect(roundUp2("0.0000001").toFixed(2)).toBe("0.01");
  });

  it("本来就是 2 位小数时原样保留", () => {
    expect(roundUp2("2.10").toFixed(2)).toBe("2.10");
    expect(roundUp2("10").toFixed(2)).toBe("10.00");
  });

  it("第 3 位非零时进位", () => {
    expect(roundUp2("1.001").toFixed(2)).toBe("1.01");
    expect(roundUp2("1.010").toFixed(2)).toBe("1.01");
  });

  it("二进制浮点残差只会让报价偏高，绝不少收", () => {
    /* 0.1 + 0.2 = 0.30000000000000004，向上取整得到 0.31 —— 这是刻意的保守行为 */
    expect(roundUp2(0.1 + 0.2).toFixed(2)).toBe("0.31");
  });

  it("负数向上取整朝 0 收敛", () => {
    expect(roundUp2("-1.005").toFixed(2)).toBe("-1.00");
  });
});

describe("round2 / roundDown2", () => {
  it("四舍五入", () => {
    expect(round2("1.005").toFixed(2)).toBe("1.01");
    expect(round2("1.004").toFixed(2)).toBe("1.00");
  });

  it("向下取整", () => {
    expect(roundDown2("1.009").toFixed(2)).toBe("1.00");
  });
});

describe("汇率换算", () => {
  it("有效汇率 = rate × (1 + markup/100)", () => {
    expect(effectiveLdcRate("1.10", 0).toFixed(4)).toBe("1.1000");
    expect(effectiveLdcRate("1.10", 10).toFixed(4)).toBe("1.2100");
  });

  it("rate <= 0 直接抛错", () => {
    expect(() => effectiveLdcRate(0)).toThrow(RangeError);
    expect(() => effectiveLdcRate("-1")).toThrow(RangeError);
  });

  it("美元 → LDC：向上取整到 2 位", () => {
    expect(usdToLdc(1, "1.1").toFixed(2)).toBe("1.10");
    expect(usdToLdc(3, "1.1").toFixed(2)).toBe("3.30");
    expect(usdToLdc(10, "1.1").toFixed(2)).toBe("11.00");
  });

  it("美元 → LDC：叠加毛利", () => {
    expect(usdToLdc(10, "1.1", 10).toFixed(2)).toBe("12.10");
    expect(usdToLdc("2.345", 1).toFixed(2)).toBe("2.35");
  });

  it("美元 → LDC：0 面值仍然是 0", () => {
    expect(usdToLdc(0, "1.1").toFixed(2)).toBe("0.00");
  });

  it("LDC → 美元：四舍五入到 2 位", () => {
    expect(ldcToUsd(11, "1.1").toFixed(2)).toBe("10.00");
    expect(ldcToUsd(10, "1.1", 10).toFixed(2)).toBe("8.26");
    expect(ldcToUsd(0, "1.1").toFixed(2)).toBe("0.00");
  });

  it("LDC → 美元：极小值向上归到 0.01 而不丢钱", () => {
    expect(ldcToUsd("0.01", "1.1").toFixed(2)).toBe("0.01");
  });

  it("互相换算在整美元上闭环", () => {
    const ldc = usdToLdc(5, "1.1");
    expect(ldcToUsd(ldc, "1.1").toFixed(2)).toBe("5.00");
  });
});

describe("边界与格式化", () => {
  it("dec 拒绝非法输入", () => {
    expect(() => dec("")).toThrow(RangeError);
    expect(() => dec("abc")).toThrow(RangeError);
    expect(() => dec(Number.NaN)).toThrow(RangeError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("0 与精确 2 位的字符串原样解析", () => {
    expect(dec("0").toFixed(4)).toBe("0.0000");
    expect(dec("2.00").toFixed(2)).toBe("2.00");
  });

  it("存库统一 4 位小数", () => {
    expect(toStorageString("1.5")).toBe("1.5000");
    expect(toStorageString(0)).toBe("0.0000");
  });

  it("展示统一 2 位小数", () => {
    expect(formatUsd("1.005")).toBe("1.01");
    expect(formatUsd("0")).toBe("0.00");
  });

  it("parseAmountInput 只接受非负有限金额", () => {
    expect(parseAmountInput("1.23")?.toFixed(2)).toBe("1.23");
    expect(parseAmountInput(0)?.toFixed(2)).toBe("0.00");
    expect(parseAmountInput("-1")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput(null)).toBeNull();
    expect(parseAmountInput({})).toBeNull();
  });

  it("求和不会产生浮点误差", () => {
    expect(sumDecimals(["0.1", "0.2"]).toFixed(2)).toBe("0.30");
  });
});
