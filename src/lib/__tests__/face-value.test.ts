/**
 * 充值金额规则：0.1 步长 + 上下限。
 *
 * 这是钱的第一道闸门，必须覆盖浮点陷阱 —— 0.1 在二进制浮点里不精确，
 * 用 `value % 0.1` 判断会误杀 1.1 / 2.3 这类完全合法的金额。
 */
import { describe, expect, it } from "vitest";
import { checkFaceAmount, snapToStep, CUSTOM_FACE_STEP_USD, MIN_CUSTOM_FACE_USD } from "../face-value";

describe("常量", () => {
  it("步长与最小金额都是 0.1", () => {
    expect(CUSTOM_FACE_STEP_USD).toBe("0.1");
    expect(MIN_CUSTOM_FACE_USD).toBe("0.1");
  });
});

describe("checkFaceAmount 合法金额", () => {
  it("接受 0.1 的整数倍", () => {
    for (const ok of ["0.1", "0.2", "0.5", "1", "1.5", "2.3", "3.7", "10", "99.9", "1000"]) {
      const r = checkFaceAmount(ok);
      expect(r.ok, `${ok} 应通过`).toBe(true);
      expect(r.reason).toBeUndefined();
    }
  });

  it("浮点陷阱：1.1 / 2.3 / 3.7 不得被误杀", () => {
    // 1.1 % 0.1 === 0.09999999999999995（JS 浮点），用 Decimal 才对
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
  it("拒绝非 0.1 整数倍", () => {
    for (const bad of ["0.05", "1.25", "2.33", "0.11", "3.14159"]) {
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
    for (const bad of ["0", "-1", "0.05", "1001", "abc"]) {
      const r = checkFaceAmount(bad);
      expect(r.reason, `${bad} 应有原因`).toBeTruthy();
      expect(/[\u4e00-\u9fff]/.test(r.reason as string), `${bad} 原因应为中文`).toBe(true);
    }
  });
});

describe("snapToStep", () => {
  it("向下取到最近的步长整数倍", () => {
    expect(snapToStep("1.25").toFixed(1)).toBe("1.2");
    expect(snapToStep("1.99").toFixed(1)).toBe("1.9");
    expect(snapToStep("3").toFixed(1)).toBe("3.0");
  });

  it("低于下限时抬到 0.1，超过上限时压到 1000", () => {
    expect(snapToStep("0").toFixed(1)).toBe("0.1");
    expect(snapToStep("0.05").toFixed(1)).toBe("0.1");
    expect(snapToStep("5000").toFixed(1)).toBe("1000.0");
  });

  it("非法输入回落到下限，不抛异常", () => {
    expect(snapToStep("abc").toFixed(1)).toBe("0.1");
  });
});
