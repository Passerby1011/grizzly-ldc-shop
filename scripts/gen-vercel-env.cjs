#!/usr/bin/env node
/**
 * 从 .env.local 生成：
 *   1) .env.local 自身补全（NEXT_PUBLIC_APP_URL 指向线上域名、CRON_SECRET 自动生成）
 *   2) .env.vercel —— 供 Vercel 后台「批量粘贴」用的部署载荷（白名单键、值不带引号）
 *
 * 两个文件都在 .gitignore 里。脚本只打印键名与摘要，绝不打印密钥值。
 *
 * 用法：node scripts/gen-vercel-env.cjs [线上域名]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const LOCAL = path.join(ROOT, ".env.local");
const OUT = path.join(ROOT, ".env.vercel");
const APP_URL = process.argv[2] || "https://grizzly-ldc-shop.vercel.app";

/** Vercel 上需要存在的键（顺序即粘贴顺序） */
const WHITELIST = [
  "GRIZZLY_API_KEY",
  "GRIZZLY_API_BASE",
  "LDC_PID",
  "LDC_KEY",
  "LDC_API_BASE",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "RATE_LDC_PER_USD",
  "MARKUP_PCT",
  "SAFETY_BUFFER_USD",
  "NEXT_PUBLIC_APP_URL",
  "CRON_SECRET",
];

/** 未配置时使用的默认值 */
const DEFAULTS = {
  GRIZZLY_API_BASE: "https://api.grizzlysms.com/stubs/handler_api.php",
  LDC_API_BASE: "https://credit.linux.do/epay",
  RATE_LDC_PER_USD: "1.10",
  MARKUP_PCT: "0",
  SAFETY_BUFFER_USD: "0.50",
};

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map.set(m[1], { value: v, raw: line });
  }
  return map;
}

if (!fs.existsSync(LOCAL)) {
  console.error("找不到 " + LOCAL + "，先创建它再运行本脚本。");
  process.exit(1);
}

const text = fs.readFileSync(LOCAL, "utf8");
const env = parseEnv(text);

// ---- 1) 补全 .env.local ----
const changes = [];

if (env.get("NEXT_PUBLIC_APP_URL")?.value !== APP_URL) {
  changes.push("NEXT_PUBLIC_APP_URL → " + APP_URL);
  env.set("NEXT_PUBLIC_APP_URL", { value: APP_URL, raw: `NEXT_PUBLIC_APP_URL=${APP_URL}` });
}

if (!env.get("CRON_SECRET")?.value) {
  const secret = crypto.randomBytes(24).toString("hex");
  changes.push("CRON_SECRET → 自动生成（48 hex）");
  env.set("CRON_SECRET", { value: secret, raw: `CRON_SECRET=${secret}` });
}

if (changes.length) {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const upsert = (key) => {
    const entry = env.get(key);
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = entry.raw;
    else lines.push(entry.raw);
  };
  upsert("NEXT_PUBLIC_APP_URL");
  upsert("CRON_SECRET");
  fs.writeFileSync(LOCAL, lines.join("\n") + "\n", "utf8");
}

// ---- 2) 生成 .env.vercel ----
const out = [];
const missing = [];
for (const key of WHITELIST) {
  let value = env.get(key)?.value;
  if (!value) value = DEFAULTS[key];
  if (!value) {
    missing.push(key);
    continue;
  }
  out.push(`${key}=${value}`);
}
fs.writeFileSync(OUT, out.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });

// ---- 3) 只打印摘要 ----
console.log("已更新 .env.local：");
for (const c of changes) console.log("  - " + c);
if (!changes.length) console.log("  （无需改动）");
console.log("");
console.log("已生成 .env.vercel：" + out.length + " 个键，顺序如下");
for (const key of WHITELIST) {
  const has = out.some((l) => l.startsWith(key + "="));
  const len = (env.get(key)?.value || DEFAULTS[key] || "").length;
  console.log(`  ${has ? "✔" : "✘"} ${key.padEnd(24)} 值长度=${len}`);
}
if (missing.length) {
  console.log("");
  console.log("⚠ 缺失且无默认值，必须手工补：" + missing.join(", "));
  process.exitCode = 2;
}
