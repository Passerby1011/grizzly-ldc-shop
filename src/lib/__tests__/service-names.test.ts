/**
 * 服务 / 地区展示名。
 *
 * ⚠️ 词典键必须是**实测的 Grizzly service code**，不能是服务英文名。
 * 本文件早期版本断言了一批推测 code（`tt` / `wx` / `st` / `pp` / `line` / `aa` …）存在，
 * 实测全部错误（真实：`lf`=TikTok、`wb`=微信、`mt`=Steam、`ts`=PayPal，列表里也没有独立的 LINE 服务项）。
 * 那种"断言错误答案存在"的测试会给出虚假安全感，比没有测试更危险——已在下方改为负向断言。
 */
import { describe, expect, it } from "vitest";
import { COUNTRY_NAMES_ZH } from "../country-names.zh";
import { displayCountryName, displayServiceName, hasChineseName, SERVICE_NAMES_ZH } from "../service-names.zh";

describe("displayCountryName（上游 chn → 本地补齐 → 英文）", () => {
  it("上游有中文名时优先用官方的", () => {
    expect(displayCountryName("Ukraine", "乌克兰")).toBe("乌克兰");
    expect(displayCountryName("United States", "美国")).toBe("美国");
    expect(displayCountryName("Ukraine", "  乌克兰  ")).toBe("乌克兰");
  });

  it("上游 chn 为空时用本地补齐表（实测 104 个国家上游没给中文）", () => {
    // 这些是实测 chn 为空、必须靠本地表兜住的
    expect(displayCountryName("Denmark", "")).toBe("丹麦");
    expect(displayCountryName("Finland", "")).toBe("芬兰");
    expect(displayCountryName("Ecuador", "")).toBe("厄瓜多尔");
    expect(displayCountryName("Togo", "")).toBe("多哥");
    expect(displayCountryName("Kuwait", "")).toBe("科威特");
    expect(displayCountryName("Fiji", "")).toBe("斐济");
    expect(displayCountryName("Switzerland", "")).toBe("瑞士");
    expect(displayCountryName("Norway", "")).toBe("挪威");
    expect(displayCountryName("Australia", "")).toBe("澳大利亚");
  });

  it("剥掉上游自带的成对引号再查表（实测坑：eng 实际是 \"Denmark\"）", () => {
    expect(displayCountryName('"Denmark"', '"Denmark"')).toBe("丹麦");
    expect(displayCountryName("'Finland'", "")).toBe("芬兰");
  });

  it("上游 chn 被填成英文原文时不得当中文采用", () => {
    // 实测：chn 可能等于英文名而非中文，必须靠 CJK 判定拦下并走本地表
    expect(displayCountryName("Denmark", "Denmark")).toBe("丹麦");
    expect(displayCountryName("Finland", "Finland")).toBe("芬兰");
    // 真中文才采用（哪怕和本地表不同）
    expect(displayCountryName("Denmark", "丹麥（官方）")).toBe("丹麥（官方）");
  });

  it("本地表也没有时回退英文", () => {
    expect(displayCountryName("Atlantis")).toBe("Atlantis");
    // Ukraine 上游 chn 有中文（不在本地补齐表里），chn 为空时只能回退英文
    expect(displayCountryName("Ukraine", "   ")).toBe("Ukraine");
  });

  it("两者都空时给出非空兜底，绝不返回空串", () => {
    const out = displayCountryName("", "");
    expect(out).toBeTruthy();
    expect(out).not.toContain("undefined");
  });

  it("ANY_COUNTRY 哨兵显示为「任意国家」", () => {
    expect(displayCountryName("ANY_COUNTRY")).toBe("任意国家");
  });
});

describe("country-names.zh 补齐表卫生", () => {
  it("条目数与实测缺口一致（103 个真实国家 + 不含哨兵）", () => {
    expect(Object.keys(COUNTRY_NAMES_ZH).length).toBe(103);
  });

  it("不含哨兵 ANY_COUNTRY", () => {
    expect(COUNTRY_NAMES_ZH["ANY_COUNTRY"]).toBeUndefined();
    expect(COUNTRY_NAMES_ZH["999999"]).toBeUndefined();
  });

  it("所有值都是中文且非空", () => {
    for (const [eng, zh] of Object.entries(COUNTRY_NAMES_ZH)) {
      expect(zh.trim(), `${eng} 的译名不应为空`).not.toBe("");
      expect(/[\u4e00-\u9fff]/.test(zh), `${eng} -> ${zh} 应为中文`).toBe(true);
    }
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

describe("hasChineseName —— 决定接码台默认列表", () => {
  /*
   * 接码台不搜索时只列「有中文名」的服务。
   * 上游 2488 个服务绝大多数是冷门英文品牌，默认全铺出来既看不懂也找不到目标。
   * 这组断言钉住这个行为，避免以后有人「顺手」改回全量。
   */

  it("有词典条目 → true", () => {
    expect(hasChineseName("tg", "Telegram")).toBe(true);
    expect(hasChineseName("wb", "WeChat")).toBe(true);
    expect(hasChineseName("zs", "Bilibili")).toBe(true);
  });

  it("上游自带中文名 → true", () => {
    expect(hasChineseName("zzz999", "某中文服务")).toBe(true);
    expect(hasChineseName("zzz998", "阿里巴巴")).toBe(true);
  });

  it("冷门英文服务 → false（默认不展示，须搜索）", () => {
    // 实测上游真实存在的 code
    expect(hasChineseName("qu", "Agroinform")).toBe(false);
    expect(hasChineseName("bsm", "Ahlan")).toBe(false);
    expect(hasChineseName("cah", "AhoraCrypto")).toBe(false);
    expect(hasChineseName("hy68", "AHOY")).toBe(false);
  });

  it("有词典条目时，即使上游名是英文也返回 true（词典优先）", () => {
    expect(hasChineseName("tg", "SomeEnglishName")).toBe(true);
  });
});
