/**
 * 充值金额规则：0.01 步长 + 上下限。
 *
 * 这是钱的第一道闸门，必须覆盖浮点陷阱 —— 0.1 在二进制浮点里不精确，
 * 用 `value % 0.01` 判断会因二进制浮点而出错。
 */
import { describe, expect, it } from "vitest";
import { checkFaceAmount, snapToStep, CUSTOM_FACE_STEP_USD, MIN_CUSTOM_FACE_USD } from "../face-value";

describe("常量", () => {
  it("步长与最小金额都是 0.01", () => {
    expect(CUSTOM_FACE_STEP_USD).toBe("0.01");
    expect(MIN_CUSTOM_FACE_USD).toBe("0.01");
  });
});

describe("checkFaceAmount 合法金额", () => {
  it("接受 0.01 的整数倍", () => {
    for (const ok of ["0.01", "0.02", "0.05", "0.1", "0.5", "1", "1.5", "2.3", "3.7", "10", "99.99", "1000"]) {
      const r = checkFaceAmount(ok);
      expect(r.ok, `${ok} 应通过`).toBe(true);
      expect(r.reason).toBeUndefined();
    }
  });

  it("0.01 是最小合法值，0.005 被拒", () => {
    expect(checkFaceAmount("0.01").ok).toBe(true);
    expect(checkFaceAmount("0.005").ok).toBe(false);
  });

  it("浮点陷阱：1.1 / 2.3 / 3.7 不得被误杀", () => {
    // 1.1 % 0.01 同样不精确，用 Decimal 才对
    for (const v of ["1.1", "2.3", "3.7", "7.9"]) {
      expect(checkFaceAmount(v).ok, `${v} 应通过`).toBe(true);
    }
  });

  it("接受 number 类型输入", () => {
    expect(checkFaceAmount(0.3).ok).toBe(true);
    expect(checkFaceAmount(5).ok).toBe(true);
  });
});

describe("checkFaceAmount 非法金额", () => {
  it("拒绝非 0.01 整数倍", () => {
    for (const bad of ["0.015", "0.011", "1.255", "2.333", "3.14159"]) {
      const r = checkFaceAmount(bad);
      expect(r.ok, `${bad} 应被拒`).toBe(false);
      expect(r.reason).toContain("整数倍");
    }
  });

  it("拒绝 0 与负数", () => {
    expect(checkFaceAmount("0").ok).toBe(false);
    expect(checkFaceAmount("0.0").ok).toBe(false);
    expect(checkFaceAmount("-1").ok).toBe(false);
    expect(checkFaceAmount(-0.1).ok).toBe(false);
  });

  it("拒绝超过上限", () => {
    const r = checkFaceAmount("1000.1");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("1000");
  });

  it("拒绝非法格式", () => {
    for (const bad of ["", "abc", "1.2.3", "--1"]) {
      const r = checkFaceAmount(bad);
      expect(r.ok, `${JSON.stringify(bad)} 应被拒`).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it("拒绝 NaN / Infinity", () => {
    expect(checkFaceAmount(Number.NaN as unknown as string).ok).toBe(false);
    expect(checkFaceAmount(Number.POSITIVE_INFINITY as unknown as string).ok).toBe(false);
  });

  it("每个拒绝分支都给得出中文原因（前端可直接展示）", () => {
    for (const bad of ["0", "-1", "0.015", "1001", "abc"]) {
      const r = checkFaceAmount(bad);
      expect(r.reason, `${bad} 应有原因`).toBeTruthy();
      expect(/[\u4e00-\u9fff]/.test(r.reason as string), `${bad} 原因应为中文`).toBe(true);
    }
  });
});

describe("snapToStep", () => {
  it("向下取到最近的步长整数倍", () => {
    expect(snapToStep("1.255").toFixed(2)).toBe("1.25");
    expect(snapToStep("1.999").toFixed(2)).toBe("1.99");
    expect(snapToStep("3").toFixed(2)).toBe("3.00");
  });

  it("低于下限时抬到 0.01，超过上限时压到 1000", () => {
    expect(snapToStep("0").toFixed(2)).toBe("0.01");
    expect(snapToStep("0.005").toFixed(2)).toBe("0.01");
    expect(snapToStep("5000").toFixed(2)).toBe("1000.00");
  });

  it("非法输入回落到下限，不抛异常", () => {
    expect(snapToStep("abc").toFixed(2)).toBe("0.01");
  });
});
