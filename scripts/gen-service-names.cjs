#!/usr/bin/env node
/**
 * 从 Grizzly 官方中文站抓取服务中文名，生成 src/lib/service-names.zh.ts 的词典部分。
 *
 *   node scripts/gen-service-names.cjs            # 只预览，不改文件
 *   node scripts/gen-service-names.cjs --write     # 写入源码
 *
 * 数据源：https://grizzlysms.com/api/service?per-page=5000&lang=cn
 *         （即 https://grizzlysms.com/cn/services 页面用的接口）
 *
 * 为什么不能照抄官方中文名：
 *   官方 2473 个服务里 287 个带中文名，但大量是机器音译/字面直译，
 *   比英文更难懂，例如：
 *     nf = 公司        （Netflix）
 *     im = 国际海事组织 （Imo，被当成 IMO）
 *     rl = 因司机      （Instacart）
 *     zo = 科格        （Kaggle）
 *   所以下面用 KEEP 白名单只保留"中国用户真会这么叫"的条目，其余回退上游原文。
 *
 * 维护：官方新增服务后重跑本脚本；若要增删条目，改 KEEP 或 OVERRIDE。
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT = path.join(__dirname, "..", "src", "lib", "service-names.zh.ts");
const API = "https://grizzlysms.com/api/service?page=1&per-page=5000&lang=cn";

/** 官方中文名可用的 code（人工筛选，见文件头说明）。 */
const KEEP = [
  // 通讯 / 社交
  "tg", "wb", "kf", "qq", "me", "hc", "wh", "tn", "gf", "dr", "mm", "pm", "dp", "nw", "hb", "pp", "ak",
  // 内容 / 娱乐
  "zs", "qf", "mb", "es", "yktd", "aql", "bue", "xngt", "bdu", "qnxc", "cbn", "bwh", "cc68", "yd68",
  "tngd", "bl", "ada", "aiw", "kp", "sf", "zh", "st",
  // 电商 / 支付 / 出行
  "am", "dh", "ew", "hw", "hwhk", "ab", "ts", "acx", "ub", "xk", "ac", "zk", "ka", "dl", "tbsh", "ep",
  "lx", "aua", "mydn", "dngf", "zhng", "lnjw", "dnzh", "mih", "bxo", "cam", "auh", "asd", "btx", "bou",
  "za", "qd", "li", "yu", "us", "fz", "bv", "vg", "gs", "an",
  // 平台 / 工具 / 云 / 中国公司
  "mt", "aon", "gr_aw", "gr_ur", "gr_ne", "blo", "btd", "bji", "asb", "ynch", "yzhn", "shng", "bjng",
  "myjt", "hngj", "mdn6", "bzi", "bzq", "axv", "hrnjie", "ot", "vp", "ccw", "atv", "agf",
];

/** 官方没给/给错，但我们知道更好的（只放含中文的值；纯英文的值等于没写）。 */
const OVERRIDE = {
  vp: "快手",       // 官方串含康熙部首 ⼿(U+2F00)，是畸形字
  ccw: "夸克",
  kuaishou: "快手",
  go: "谷歌 / Gmail / YouTube",
  tg: "电报",       // 官方只写 "TG"
  aon: "币安",      // 官方只写 "Binance"
  mt: "蒸汽平台",
  ts: "贝宝",
  dh: "易趣",
};

/** 官方中文名是字面翻译、毫无信息量，直接弃用。 */
const DROP = new Set(["abq"]); // "自由职业" = Freelancer

const GROUPS = [
  ["通讯 / 社交", ["tg", "wb", "kf", "qq", "me", "hc", "wh", "tn", "gf", "dr", "mm", "pm", "dp", "nw", "hb", "pp", "ak"]],
  ["内容 / 娱乐", ["zs", "qf", "mb", "es", "yktd", "aql", "bue", "xngt", "bdu", "qnxc", "cbn", "bwh", "cc68", "yd68", "tngd", "bl", "ada", "aiw", "kp", "sf", "zh", "st"]],
  ["电商 / 支付 / 出行", ["am", "dh", "ew", "hw", "hwhk", "ab", "ts", "acx", "ub", "xk", "ac", "zk", "ka", "dl", "tbsh", "ep", "lx", "aua", "mydn", "dngf", "zhng", "lnjw", "dnzh", "mih", "bxo", "cam", "auh", "asd", "btx", "bou", "za", "qd", "li", "yu", "us", "fz", "bv", "vg", "gs", "an"]],
  ["平台 / 工具 / 云", ["mt", "aon", "gr_aw", "gr_ur", "gr_ne", "blo", "btd", "bji", "asb", "ynch", "yzhn", "shng", "bjng", "myjt", "hngj", "mdn6", "bzi", "bzq", "axv", "hrnjie", "ot", "vp", "ccw", "atv", "agf"]],
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("非 JSON: " + d.slice(0, 120))); }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const write = process.argv.includes("--write");
  const list = await fetchJson(API);
  console.log(`官方返回 ${list.length} 个服务`);

  const byCode = new Map(list.map((s) => [String(s.external_id).trim(), String(s.name ?? "").trim()]));
  const HAN = /[\u4e00-\u9fff]/;

  const merged = {};
  let keptFromOfficial = 0;
  let skippedNoHan = 0;
  for (const code of KEEP) {
    if (DROP.has(code)) continue;
    const name = byCode.get(code);
    if (!name || !HAN.test(name)) { skippedNoHan++; continue; }
    merged[code] = name;
    keptFromOfficial++;
  }
  Object.assign(merged, OVERRIDE);

  /* 硬规则：词典值必须含汉字，纯英文交给原文回退 */
  for (const [code, name] of Object.entries(merged)) {
    if (!HAN.test(name)) throw new Error(`词条 ${code}="${name}" 不含汉字，应删除或改用原文回退`);
  }

  console.log(`白名单命中 ${keptFromOfficial} 条；白名单里官方已无中文 ${skippedNoHan} 条`);
  console.log(`最终词条 ${Object.keys(merged).length} 条`);

  const lines = [
    "/** 服务中文名映射。键为 Grizzly service code（实测值）。 */",
    "export const SERVICE_NAMES_ZH: Record<string, string> = {",
  ];
  const used = new Set();
  for (const [title, codes] of GROUPS) {
    const items = [];
    for (const c of codes) {
      if (used.has(c) || !merged[c]) continue;
      used.add(c);
      items.push(`  ${JSON.stringify(c)}: ${JSON.stringify(merged[c])},`);
    }
    if (!items.length) continue;
    lines.push(`  /* —— ${title} —— */`);
    lines.push(...items, "");
  }
  const rest = Object.keys(merged).filter((c) => !used.has(c));
  if (rest.length) {
    lines.push("  /* —— 其他 —— */");
    for (const c of rest) lines.push(`  ${JSON.stringify(c)}: ${JSON.stringify(merged[c])},`);
    lines.push("");
  }
  lines.push("};");
  const block = lines.join("\n");

  if (!write) {
    console.log("\n--- 预览（未写入，加 --write 生效）---\n" + block);
    return;
  }

  const src = fs.readFileSync(OUT, "utf8");
  const startMarker = "/** 服务中文名映射。键为 Grizzly service code（实测值）。 */";
  const endMarker = "/** 中日韩字符（汉字 / 假名 / 谚文）。上游 name 自带这些字符时原样使用。 */";
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker);
  if (i < 0 || j < 0) throw new Error("在 service-names.zh.ts 里找不到词典边界，未修改");

  const changelog = `/**
 * CHANGELOG
 * 数据来源：https://grizzlysms.com/api/service?per-page=5000&lang=cn（官方 /cn/services 页的接口）
 *   官方共 2473 个服务，其中 287 个带中文名；287 条里大量是机器音译
 *   （nf=公司、im=国际海事组织、rl=因司机、zo=科格…），照抄比英文更难懂，
 *   故人工筛出约 ${Object.keys(merged).length} 条可用的，其余回退上游原文。
 *   官方没给或给错的用脚本内 OVERRIDE 补。
 *   重新生成：node scripts/gen-service-names.cjs --write
 */

`;

  fs.writeFileSync(OUT, src.slice(0, i) + block + "\n\n" + changelog + src.slice(j), "utf8");
  console.log(`已写入 ${OUT}`);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
