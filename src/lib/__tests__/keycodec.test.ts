import { describe, expect, it } from "vitest";
import {
  codePrefix,
  constantTimeEqual,
  generateCode,
  generateKeyBody,
  hashCode,
  isValidCode,
  KEY_ALPHABET,
  KEY_BODY_LENGTH,
  maskCode,
  normalizeCode,
  parseCode,
  signSessionToken,
  verifySessionToken,
} from "../keycodec";

const CODE_PATTERN = /^GS(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

describe("生成", () => {
  it("格式恒为 GS-XXXX-XXXX-XXXX-XXXX", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateCode()).toMatch(CODE_PATTERN);
    }
  });

  it("随机体只使用 Crockford 字母表（无 I/L/O/U）", () => {
    const body = generateKeyBody();
    expect(body).toHaveLength(KEY_BODY_LENGTH);
    for (const char of body) expect(KEY_ALPHABET).toContain(char);
    expect(body).not.toMatch(/[ILOU]/);
  });

  it("两次生成不重复", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(codes.size).toBe(500);
  });
});

describe("归一化与校验", () => {
  it("生成 → 归一化 → 原样返回（往返）", () => {
    const code = generateCode();
    expect(normalizeCode(code)).toBe(code);
    expect(isValidCode(code)).toBe(true);
  });

  it("小写 / 无分隔符 / 空格都能救回来", () => {
    const code = generateCode();
    const messy = code.replace(/-/g, " ").toLowerCase();
    expect(normalizeCode(messy)).toBe(code);
    expect(normalizeCode(code.replace(/-/g, ""))).toBe(code);
  });

  it("Crockford 易混字符回填：I/L → 1，O → 0", () => {
    expect(normalizeCode("GS-IIII-IIII-IIII-IIII")).toBe("GS-1111-1111-1111-1111");
    expect(normalizeCode("GS-LLLL-LLLL-LLLL-LLLL")).toBe("GS-1111-1111-1111-1111");
    expect(normalizeCode("GS-OOOO-OOOO-OOOO-OOOO")).toBe("GS-0000-0000-0000-0000");
  });

  it("非法输入拒绝", () => {
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode("GS-XXXX-XXXX-XXXX-XXX")).toBeNull(); // 少一位
    expect(normalizeCode("GS-XXXX-XXXX-XXXX-XXXXX")).toBeNull(); // 多一位
    expect(normalizeCode("GS-UUUU-UUUU-UUUU-UUUU")).toBeNull(); // U 不在字母表
    expect(normalizeCode("hello world")).toBeNull();
    expect(normalizeCode("GS-!!!!-!!!!-!!!!-!!!!")).toBeNull();
  });

  it("parseCode 返回规范化明文与 body", () => {
    const code = generateCode();
    const parsed = parseCode(code);
    expect(parsed?.code).toBe(code);
    expect(parsed?.body).toHaveLength(KEY_BODY_LENGTH);
  });
});

describe("哈希与展示", () => {
  it("生成 → 哈希 → 校验往返", () => {
    const code = generateCode();
    const hash = hashCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(normalizeCode(code) as string)).toBe(hash);
    expect(hashCode(code.toLowerCase())).toBe(hash);
  });

  it("不同卡密哈希不同", () => {
    expect(hashCode(generateCode())).not.toBe(hashCode(generateCode()));
  });

  it("非法卡密无法哈希", () => {
    expect(() => hashCode("not-a-code")).toThrow(RangeError);
  });

  it("前缀取首组，掩码不泄露中段", () => {
    const code = generateCode();
    expect(codePrefix(code)).toBe(code.slice(0, 7));
    const masked = maskCode(code);
    expect(masked).toContain("****");
    expect(masked).not.toBe(code);
    expect(masked.startsWith(code.slice(0, 7))).toBe(true);
    expect(maskCode("bad")).toBe("GS-****-****-****-****");
  });
});

describe("会话令牌", () => {
  const secret = "unit-test-secret";

  it("签发的令牌可验证", () => {
    const token = signSessionToken("key_123", 60_000, secret);
    expect(verifySessionToken(token, secret)).toEqual({ keyId: "key_123" });
  });

  it("换密钥验不过", () => {
    const token = signSessionToken("key_123", 60_000, secret);
    expect(verifySessionToken(token, "another-secret")).toBeNull();
  });

  it("被篡改的 payload 验不过", () => {
    const token = signSessionToken("key_123", 60_000, secret);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "key_999", e: Date.now() + 60_000 })).toString(
      "base64url",
    );
    expect(verifySessionToken(`${forged}.${sig}`, secret)).toBeNull();
    expect(verifySessionToken(`${payload}.deadbeef`, secret)).toBeNull();
    expect(verifySessionToken("garbage", secret)).toBeNull();
    expect(verifySessionToken(null, secret)).toBeNull();
  });

  it("过期令牌无效", () => {
    const token = signSessionToken("key_123", -1000, secret);
    expect(verifySessionToken(token, secret)).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("等值判断正确", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
