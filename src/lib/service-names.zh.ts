/**
 * 服务 / 地区中文展示名。
 *
 * 上游事实（2026-10-10 实测，勿改）：
 * - `getCountries` 每项自带 `chn` 中文字段（例：`{"id":1,"eng":"Ukraine","chn":"乌克兰"}`），直接用；
 * - `getServicesList` 只返回英文 `name`，试过 `lang=chn` / `lang=zh` / `language=chn` 均无效，
 *   所以服务中文名只能本地维护词典，未命中时优雅回退英文；
 * - `getServicesList` 每次请求顺序都不一样（被打乱），展示前必须做确定性排序；
 * - 实测共 2488 个服务，其中 52 个上游 `name` 自带中文（如 `btx`="Amap 高德地图"），那些走第 2 条规则。
 *
 * ⚠️ 下表 code 全部来自真实 `getServicesList` 返回，不是推测。
 * 早期版本曾用推测 code（如把 `lf` 当成 LINE、`tt` 当成 TikTok），实测都是错的：
 *   `lf` 实际是 TikTok、TikTok 的 code 是 lf；LINE 在列表里没有独立服务项。
 * 修正记录见本文件下方 CHANGELOG。
 */
import { COUNTRY_NAMES_ZH } from "./country-names.zh";

/** 服务中文名映射。键为 Grizzly service code（实测值）。 */
export const SERVICE_NAMES_ZH: Record<string, string> = {
  /* —— 通讯 / 社交 —— */
  tg: "电报",
  wa: "WhatsApp",
  wb: "微信",
  ds: "Discord",
  vi: "Viber",
  tw: "Twitter / X",
  ig: "Instagram",
  fb: "脸谱",
  gr_sg: "Signal",

  /* —— 内容 / 娱乐 —— */
  zs: "哔哩哔哩",
  qf: "小红书",
  lf: "TikTok",
  mb: "雅虎",
  nf: "Netflix",

  /* —— 平台 / 工具 —— */
  go: "谷歌 / Gmail / YouTube",
  dr: "AI 聊天",
  nv: "Naver",
  tme: "OurTime",

  /* —— 电商 / 支付 —— */
  am: "亚马逊",
  dh: "eBay",
  ew: "耐克",
  hw: "支付宝",
  ab: "阿里巴巴",
  ts: "PayPal",

  /* —— 出行 / 游戏 / 金融 —— */
  ub: "优步",
  mt: "Steam",
  aon: "币安",
  aor: "OKX",
};

/**
 * CHANGELOG
 * 2026-10-10 重写：改用实测 code。删除不存在或错误的条目：
 *   telegram / whatsapp / google / facebook / instagram / twitter / discord
 *   （这些是服务名而非 code）、tt（TikTok 实际是 lf）、wx（微信实际是 wb）、
 *   st（Steam 实际是 mt）、pp（PayPal 实际是 ts）、line（列表无此独立服务）、
 *   aa / openai / chatgpt / binance / okx / yandex / vk / ozon / avito /
 *   youtube / mail（未在实测响应中确认对应 code，宁缺勿错，交给英文回退）。
 */

/** 中日韩字符（汉字 / 假名 / 谚文）。上游 name 自带这些字符时原样使用。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 归一化上游字段。
 *
 * ⚠️ 实测坑（2026-10-10）：上游部分国家的 `eng` / `chn` 值**自带首尾双引号**，
 * 例如 `eng` 实际是 `"Denmark"`（含引号），`chn` 也被填成了同样的英文原文而非中文。
 * 不剥引号会导致：查表查不中、`chn` 判空误判（把英文当中文用）。
 */
function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  let s = value.trim();
  // 剥掉可能存在的成对引号（可能嵌套一层）
  for (let i = 0; i < 2; i += 1) {
    if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
      s = s.slice(1, -1).trim();
    } else break;
  }
  return s;
}

/**
 * 取国家展示名，三层兜底：
 *   1. 上游 `chn` 有**中文** → 用官方的（实测只有 102 个真有中文）
 *   2. 否则查本地补齐表（其余 104 个上游没给中文）
 *   3. 再回退英文 `eng`，最后兜底「未知地区」
 *
 * ⚠️ 顺序不能颠倒：绝不用本地译名覆盖上游官方译名。
 */
export function displayCountryName(eng: string, chn?: string): string {
  const zh = clean(chn);
  // 上游 chn 有时被填成英文原文，必须确认真的是中文才采用
  if (zh && CJK_PATTERN.test(zh)) return zh;

  const en = clean(eng);
  /* 999999 = ANY_COUNTRY，是"任意国家"哨兵不是真国家 */
  if (en === "ANY_COUNTRY") return "任意国家";

  const local = en ? COUNTRY_NAMES_ZH[en] : undefined;
  if (local) return local;

  return en || zh || "未知地区";
}

/**
 * 取展示名，四层兜底：
 *   1. 词典命中 → 中文
 *   2. 上游 name 含 CJK → 原样用（实测 52 个服务自带中文名）
 *   3. 回退上游英文 name
 *   4. 再兜底返回 code
 * 绝不返回空串或 "undefined"。
 */
export function displayServiceName(code: string, upstreamName: string): string {
  const key = typeof code === "string" ? code.trim() : "";
  const zh = SERVICE_NAMES_ZH[key] ?? SERVICE_NAMES_ZH[key.toLowerCase()];
  if (zh) return zh;

  const name = typeof upstreamName === "string" ? upstreamName.trim() : "";
  if (name && CJK_PATTERN.test(name)) return name;

  return name || key || "未知服务";
}
