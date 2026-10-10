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
  "tg": "电报",
  "wb": "微信",
  "kf": "微博",
  "qq": "腾讯QQ",
  "me": "连我",
  "hc": "陌陌",
  "wh": "探探",
  "tn": "领英",
  "gf": "谷歌语音",
  "dr": "AI 聊天",
  "mm": "微软 + Outlook",
  "pm": "美国在线",
  "dp": "质子邮件",
  "nw": "喜马拉雅",
  "hb": "图奇",
  "pp": "虎牙",
  "ak": "斗鱼",

  /* —— 内容 / 娱乐 —— */
  "zs": "哔哩哔哩",
  "qf": "小红书",
  "mb": "雅虎",
  "es": "爱奇艺",
  "yktd": "优酷土豆 / Youku",
  "aql": "Xigua Video 西瓜视频",
  "bue": "映客 inke",
  "xngt": "醒图",
  "bdu": "星城Online",
  "qnxc": "群侠传",
  "cbn": "TrueCOLOR 本色",
  "bwh": "EOS RED 靈境殺戮",
  "cc68": "测测",
  "yd68": "易达",
  "tngd": "通达文",
  "bl": "BIGO直播",
  "ada": "真相社交",
  "aiw": "罗布乐思",
  "kp": "HQ趣味问答",
  "sf": "声田",
  "zh": "卓豪",
  "st": "欧尚",

  /* —— 电商 / 支付 / 出行 —— */
  "am": "亚马逊",
  "dh": "易趣",
  "ew": "耐克",
  "hw": "支付宝",
  "hwhk": "香港支付宝",
  "ab": "阿里巴巴",
  "ts": "贝宝",
  "acx": "贝宝",
  "ub": "优步",
  "xk": "滴滴出行",
  "ac": "达达快送",
  "zk": "户户送",
  "ka": "虾皮",
  "dl": "来赞达",
  "tbsh": "淘宝闪购",
  "ep": "特木电商",
  "lx": "得物毒",
  "aua": "同程旅行 Tongcheng Travel",
  "mydn": "蚂蚁短租",
  "dngf": "东方航空",
  "zhng": "中国民航信息",
  "lnjw": "链家网",
  "dnzh": "店长直聘",
  "mih": "米画师Mihuashi",
  "bxo": "悠遊卡 EasyCard",
  "cam": "Eleme 饿了么",
  "auh": "KeeTa 美团",
  "asd": "Hongguo 红果短剧",
  "btx": "Amap 高德地图",
  "bou": "汇旺支付",
  "za": "京东",
  "qd": "淘宝",
  "li": "百度",
  "yu": "小米",
  "us": "印度铁路",
  "fz": "肯德基",
  "bv": "麦德龙",
  "vg": "壳牌",
  "gs": "三星",
  "an": "阿迪达斯",

  /* —— 平台 / 工具 / 云 —— */
  "mt": "蒸汽平台",
  "aon": "币安",
  "gr_aw": "亚马逊云服务",
  "gr_ur": "微软云",
  "gr_ne": "网易",
  "blo": "SiliconFlow 硅基流动",
  "btd": "Volcengine 火山引擎",
  "bji": "Perfect World 完美世界",
  "asb": "YUEWEN 阅文集团",
  "ynch": "yuancai / 灏捷科技",
  "yzhn": "月之暗面",
  "shng": "上海淅画科技",
  "bjng": "北京与你科技有限公司",
  "myjt": "螞蟻集團",
  "hngj": "恒基 / HCOINS",
  "mdn6": "密电",
  "bzi": "MoneyBack 易賞錢",
  "bzq": "Maitix 麦座",
  "axv": "AIA 友邦保險",
  "hrnjie": "华人街",
  "ot": "其他",
  "vp": "快手",
  "ccw": "夸克",
  "atv": "快手 Kuaishou",
  "agf": "美图",

  /* —— 其他 —— */
  "kuaishou": "快手",
  "go": "谷歌 / Gmail / YouTube",

};

/**
 * CHANGELOG
 * 数据来源：https://grizzlysms.com/api/service?per-page=5000&lang=cn（官方 /cn/services 页的接口）
 *   官方共 2473 个服务，其中 287 个带中文名；287 条里大量是机器音译
 *   （nf=公司、im=国际海事组织、rl=因司机、zo=科格…），照抄比英文更难懂，
 *   故人工筛出约 106 条可用的，其余回退上游原文。
 *   官方没给或给错的用脚本内 OVERRIDE 补。
 *   重新生成：node scripts/gen-service-names.cjs --write
 */

/** 中日韩字符（汉字 / 假名 / 谚文）。上游 name 自带这些字符时原样使用。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 汉字（不含日文假名 / 韩文谚文）。
 * 「是不是中文」用这个；判断要不要原样沿用上游名才用 CJK_PATTERN。
 */
const HAN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

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
/**
 * 该服务是否有中文名（本地词典命中，或上游自带中文）。
 *
 * 用途：接码台「不搜索时默认只列有中文名的服务」。
 * 上游 2488 个服务绝大多数是冷门英文品牌（Agroinform、Ahoy…），
 * 默认铺满英文列表既看不懂也找不到目标；要什么直接搜，搜索覆盖全部。
 */
export function hasChineseName(code: string, upstreamName: string): boolean {
  return HAN_PATTERN.test(displayServiceName(code, upstreamName));
}

export function displayServiceName(code: string, upstreamName: string): string {
  const key = typeof code === "string" ? code.trim() : "";
  const zh = SERVICE_NAMES_ZH[key] ?? SERVICE_NAMES_ZH[key.toLowerCase()];
  if (zh) return zh;

  const name = typeof upstreamName === "string" ? upstreamName.trim() : "";
  if (name && CJK_PATTERN.test(name)) return name;

  return name || key || "未知服务";
}
