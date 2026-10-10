import { describe, expect, it } from "vitest";
import { displayCountryName, displayServiceName, SERVICE_NAMES_ZH } from "../service-names.zh";

describe("displayCountryName（优先 chn → 回退 eng）", () => {
  it("上游有中文名时用中文", () => {
    expect(displayCountryName("Ukraine", "乌克兰")).toBe("乌克兰");
    expect(displayCountryName("USA", "美国")).toBe("美国");
    expect(displayCountryName("Ukraine", "  乌克兰  ")).toBe("乌克兰");
  });

  it("没有 chn 时回退 eng", () => {
    expect(displayCountryName("Ukraine")).toBe("Ukraine");
    expect(displayCountryName("Ukraine", "")).toBe("Ukraine");
    expect(displayCountryName("Ukraine", "   ")).toBe("Ukraine");
  });
});

describe("displayServiceName（词典 → 上游自带中文 → 英文回退）", () => {
  it("命中中文词典时用词典名", () => {
    expect(displayServiceName("am", "Amazon")).toBe("亚马逊");
    expect(displayServiceName("wx", "WeChat")).toBe("微信");
    expect(displayServiceName("binance", "Binance")).toBe("币安");
  });

  it("上游 name 本身含中文时原样使用（实测 zhng → 中国民航信息）", () => {
    expect(displayServiceName("zhng", "中国民航信息")).toBe("中国民航信息");
  });

  it("未命中词典且是英文时回退英文", () => {
    expect(displayServiceName("sk", "Skroutz")).toBe("Skroutz");
  });

  it("name 缺失也不显示 undefined/空", () => {
    expect(displayServiceName("zzz", "")).toBe("zzz");
    expect(displayServiceName("zzz", "   ")).toBe("zzz");
  });
});

describe("SERVICE_NAMES_ZH 覆盖 SPEC 列出的常见 code", () => {
  it("关键 code 都有展示名", () => {
    const codes = [
      "tg",
      "telegram",
      "wa",
      "whatsapp",
      "fb",
      "ig",
      "go",
      "google",
      "tw",
      "twitter",
      "ds",
      "discord",
      "lf",
      "line",
      "vi",
      "viber",
      "wx",
      "wechat",
      "tt",
      "tiktok",
      "am",
      "amazon",
      "nf",
      "netflix",
      "st",
      "steam",
      "pp",
      "paypal",
      "ub",
      "uber",
      "dr",
      "aa",
      "openai",
      "chatgpt",
      "binance",
      "okx",
      "yandex",
      "vk",
      "ozon",
      "avito",
      "youtube",
      "yahoo",
      "mail",
    ];
    for (const code of codes) {
      expect(SERVICE_NAMES_ZH[code], code).toBeTruthy();
    }
  });
});
