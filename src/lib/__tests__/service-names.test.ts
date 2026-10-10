/**
 * 服务 / 地区展示名。
 *
 * ⚠️ 词典键必须是**实测的 Grizzly service code**，不能是服务英文名。
 * 本文件早期版本断言了一批推测 code（`tt` / `wx` / `st` / `pp` / `line` / `aa` …）存在，
 * 实测全部错误（真实：`lf`=TikTok、`wb`=微信、`mt`=Steam、`ts`=PayPal，列表里也没有独立的 LINE 服务项）。
 * 那种"断言错误答案存在"的测试会给出虚假安全感，比没有测试更危险——已在下方改为负向断言。
 */
import { describe, expect, it } from "vitest";
import { displayCountryName, displayServiceName, SERVICE_NAMES_ZH } from "../service-names.zh";

describe("displayCountryName（优先 chn → 回退 eng）", () => {
  it("上游有中文名时用中文", () => {
    expect(displayCountryName("Ukraine", "乌克兰")).toBe("乌克兰");
    expect(displayCountryName("United States", "美国")).toBe("美国");
    expect(displayCountryName("Ukraine", "  乌克兰  ")).toBe("乌克兰");
  });

  it("没有 chn 时回退 eng", () => {
    expect(displayCountryName("Ukraine")).toBe("Ukraine");
    expect(displayCountryName("Ukraine", "")).toBe("Ukraine");
    expect(displayCountryName("Ukraine", "   ")).toBe("Ukraine");
  });

  it("两者都空时给出非空兜底，绝不返回空串", () => {
    const out = displayCountryName("", "");
    expect(out).toBeTruthy();
    expect(out).not.toContain("undefined");
  });
});

describe("displayServiceName（词典 → 上游自带中文 → 英文回退 → code 兜底）", () => {
  it("命中词典的实测 code 返回中文名", () => {
    const cases: Array<[string, string]> = [
      ["tg", "电报"],
      ["wa", "WhatsApp"],
      ["wb", "微信"],
      ["zs", "哔哩哔哩"],
      ["qf", "小红书"],
      ["lf", "TikTok"],
      ["mb", "雅虎"],
      ["ig", "Instagram"],
      ["fb", "脸谱"],
      ["dr", "AI 聊天"],
      ["ub", "优步"],
      ["am", "亚马逊"],
      ["hw", "支付宝"],
      ["aon", "币安"],
      ["aor", "OKX"],
      ["mt", "Steam"],
      ["ts", "PayPal"],
      ["dh", "eBay"],
      ["gr_sg", "Signal"],
    ];
    for (const [code, expected] of cases) {
      expect(displayServiceName(code, "ignored-upstream-name"), `${code} 应显示 ${expected}`).toBe(expected);
    }
  });

  it("词典优先于上游英文名", () => {
    expect(displayServiceName("tg", "Telegram")).toBe("电报");
  });

  it("上游 name 本身含中文时原样使用（实测有 52 个服务如此）", () => {
    expect(displayServiceName("zhng", "中国民航信息")).toBe("中国民航信息");
    expect(displayServiceName("btx", "Amap 高德地图")).toBe("Amap 高德地图");
    expect(displayServiceName("blo", "SiliconFlow 硅基流动")).toBe("SiliconFlow 硅基流动");
  });

  it("未命中词典且是英文时回退英文", () => {
    expect(displayServiceName("sk", "Skroutz")).toBe("Skroutz");
  });

  it("name 缺失时回退 code，绝不显示 undefined/空", () => {
    expect(displayServiceName("zzz", "")).toBe("zzz");
    expect(displayServiceName("zzz", "   ")).toBe("zzz");
  });

  it("完全无输入时给出可读兜底", () => {
    const out = displayServiceName("", "");
    expect(out).toBeTruthy();
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("null");
  });
});

describe("词典卫生（负向断言：推测 code 必须不存在）", () => {
  it("不含被实测证伪的推测 code", () => {
    // 这些曾是推测值，实测在 getServicesList 里要么不存在、要么张冠李戴
    const provedWrong = ["tt", "wx", "st", "pp", "aa", "line", "telegram", "whatsapp", "google", "twitter", "discord"];
    for (const code of provedWrong) {
      expect(SERVICE_NAMES_ZH[code], `${code} 是推测值，不应存在于词典（会掩盖真实 code）`).toBeUndefined();
    }
  });

  it("实测 code 必须存在，防止有人误删", () => {
    const mustExist = ["tg", "wa", "wb", "lf", "mt", "ts", "zs", "qf", "mb", "dr", "am", "ub", "hw", "aon", "aor", "dh", "gr_sg", "ig", "fb", "nv", "tme", "go"];
    for (const code of mustExist) {
      expect(SERVICE_NAMES_ZH[code], `${code} 是实测 code，必须保留`).toBeTruthy();
    }
  });

  it("所有词典值都非空", () => {
    for (const [code, name] of Object.entries(SERVICE_NAMES_ZH)) {
      expect(name.trim(), `${code} 的值不应为空`).not.toBe("");
    }
  });
});
