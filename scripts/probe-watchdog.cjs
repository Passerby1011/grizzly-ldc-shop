#!/usr/bin/env node
/**
 * 独立看门狗：到点强制取消一个号码，然后清掉账本条目。
 *
 * 由 probe-number.cjs 以 detached 方式拉起，**不随主进程退出而死**。
 * 这样即使主进程被 kill -9（Windows 上 timeout/taskkill 就是硬杀，Node
 * 收不到任何信号），号码依然会被取消 —— 不依赖任何进程内处理器。
 *
 * 用法（一般不用手调）：
 *   node scripts/probe-watchdog.cjs <activationId> <delaySeconds>
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const LEDGER = path.join(__dirname, "..", ".probe-pending.json");
const BASE = "https://api.grizzlysms.com/stubs/handler_api.php";

function envKey() {
  if (process.env.GRIZZLY_API_KEY) return process.env.GRIZZLY_API_KEY.trim();
  const p = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith("GRIZZLY_API_KEY="));
  return line ? line.slice("GRIZZLY_API_KEY=".length).replace(/^"|"$/g, "").trim() : null;
}

const KEY = envKey();
const id = process.argv[2];
const delaySec = Number(process.argv[3] || 60);

function call(params) {
  const qs = new URLSearchParams({ api_key: KEY, ...params }).toString();
  return new Promise((resolve) => {
    const req = https.get(`${BASE}?${qs}`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d.trim()));
    });
    req.on("error", (e) => resolve("ERR:" + e.message));
    req.setTimeout(20000, () => { req.destroy(); resolve("ERR:timeout"); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clearLedger(target) {
  try {
    if (!fs.existsSync(LEDGER)) return;
    const obj = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    delete obj[target];
    if (Object.keys(obj).length === 0) fs.unlinkSync(LEDGER);
    else fs.writeFileSync(LEDGER, JSON.stringify(obj, null, 2), "utf8");
  } catch { /* 账本清理失败无所谓，reaper 会重试 */ }
}

(async () => {
  if (!KEY || !id) process.exit(1);
  await sleep(Math.max(0, delaySec) * 1000);

  /* 最多重试到 400 秒（取消窗口实测 64s～334s） */
  const t0 = Date.now();
  while (Date.now() - t0 < 400000) {
    const r = await call({ action: "setStatus", id, status: "8" });
    if (r.startsWith("ACCESS_CANCEL") || r.includes("NO_ACTIVATION")) {
      clearLedger(id);
      process.exit(0);
    }
    if (r.includes("EARLY_CANCEL_DENIED")) { await sleep(15000); continue; }
    await sleep(5000);
  }
  /* 没能取消：把 ID 留在账本里，交给 reaper 与人工 */
  process.exit(2);
})();
