/**
 * 服务 / 地区中文展示名。
 *
 * 上游事实（2026-10-10 实测，勿改）：
 * - `getCountries` 每项自带 `chn` 中文字段（例：`{"id":1,"eng":"Ukraine","chn":"乌克兰"}`），直接用；
 * - `getServicesList` 只返回英文 `name`，试过 `lang=chn` / `lang=zh` / `language=chn` 均无效，
 *   所以服务中文名只能本地维护词典，未命中时优雅回退英文；
 * - `getServicesList` 每次请求顺序都不一样（被打乱），展示前必须做确定性排序。
 */

/** 服务中文名映射。键为 Grizzly service code。上游无中文，只能本地维护。 */
export const SERVICE_NAMES_ZH: Record<string, string> = {
  tg: "Telegram",
  telegram: "Telegram",
  wa: "WhatsApp",
  whatsapp: "WhatsApp",
  fb: "Facebook",
  ig: "Instagram",
  go: "Google",
  google: "Google",
  tw: "Twitter/X",
  twitter: "Twitter/X",
  ds: "Discord",
  discord: "Discord",
  lf: "LINE",
  line: "LINE",
  vi: "Viber",
  viber: "Viber",
  wx: "微信",
  wechat: "微信",
  tt: "TikTok",
  tiktok: "TikTok",
  am: "亚马逊",
  amazon: "亚马逊",
  nf: "Netflix",
  netflix: "Netflix",
  st: "Steam",
  steam: "Steam",
  pp: "PayPal",
  paypal: "PayPal",
  ub: "Uber",
  uber: "Uber",
  dr: "AI Chat",
  aa: "任意服务",
  openai: "OpenAI",
  chatgpt: "OpenAI",
  binance: "币安",
  okx: "OKX",
  yandex: "Yandex",
  vk: "VK",
  ozon: "Ozon",
  avito: "Avito",
  youtube: "YouTube",
  yahoo: "Yahoo",
  mail: "邮箱",
};

/** 中日韩字符（汉字 / 假名 / 谚文）。上游 name 自带这些字符时原样使用。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 取展示名：优先中文词典 → 若上游 name 本身含中日韩字符则原样用 → 否则回退英文 name。 */
export function displayServiceName(code: string, upstreamName: string): string {
  const zh = SERVICE_NAMES_ZH[code] ?? SERVICE_NAMES_ZH[code.toLowerCase()];
  if (zh) return zh;
  const name = typeof upstreamName === "string" ? upstreamName.trim() : "";
  if (name && CJK_PATTERN.test(name)) return name;
  /* 未命中词典时优雅回退英文；name 也没有就回退 code，绝不显示 undefined/空 */
  return name || code;
}

/** 取国家展示名：优先 chn → 回退 eng。 */
export function displayCountryName(eng: string, chn?: string): string {
  const zh = typeof chn === "string" ? chn.trim() : "";
  return zh || eng;
}
