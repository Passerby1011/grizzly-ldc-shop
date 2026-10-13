#!/usr/bin/env node
/**
 * 真实号码探针 —— 带**强制回收**保护。
 *
 * ⚠️ 为什么必须用这个而不是直接调 Grizzly：
 * 上游号码「有效期起只有 20 分钟」，官方 FAQ 说明购买后 20 分钟内才可退款。
 * 手工取号后忘记取消 = 钱直接损失（已发生过：留了两个号在库里，超出 20 分钟
 * 窗口后退不回款，靠人工清理）。
 *
 * 本工具用 try/finally 保证：**无论中间发生什么（异常、超时、Ctrl+C），
 * 退出前一定尝试 setStatus(8) 取消**。取消放开时间实测 64s～334s，
 * 所以最长等 400 秒再撤销。
 *
 * 用法：
 *   node scripts/probe-number.cjs                    # 取号并等 5 秒后取消（冒烟）
 *   node scripts/probe-number.cjs --hold 60          # 持有 60 秒再取消
 *   node scripts/probe-number.cjs --service tg --country any --max 0.20
 *   node scripts/probe-number.cjs --wait-cancel      # 一直重试到取消成功为止
 *
 * 退出码：0 = 号码已确认取消（或从未取到）；1 = 取号失败；2 = 取到了但没取消掉（危险）
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://api.grizzlysms.com/stubs/handler_api.php";
const MAX_HOLD_SEC = 400;

function envKey() {
  if (process.env.GRIZZLY_API_KEY) return process.env.GRIZZLY_API_KEY.trim();
  const p = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith("GRIZZLY_API_KEY="));
  return line ? line.slice("GRIZZLY_API_KEY=".length).replace(/^"|"$/g, "").trim() : null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function call(params) {
  const qs = new URLSearchParams({ api_key: KEY, ...params }).toString();
  return new Promise((resolve) => {
    const req = https.get(`${BASE}?${qs}`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d.trim()));
    });
    req.on("error", (e) => resolve("ERR:" + e.message));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve("ERR:timeout");
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = envKey();
const LEDGER = path.join(__dirname, "..", ".probe-pending.json");

/** 把待取消的号写进账本（崩溃后可由 reaper 兜底）。 */
function recordPending(id) {
  try {
    const obj = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
    obj[id] = { at: new Date().toISOString() };
    fs.writeFileSync(LEDGER, JSON.stringify(obj, null, 2), "utf8");
  } catch { /* 落盘失败不阻断流程，看门狗仍在 */ }
}

function forgetPending(id) {
  try {
    if (!fs.existsSync(LEDGER)) return;
    const obj = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    delete obj[id];
    if (Object.keys(obj).length === 0) fs.unlinkSync(LEDGER);
    else fs.writeFileSync(LEDGER, JSON.stringify(obj, null, 2), "utf8");
  } catch { /* 忽略 */ }
}

/** 拉起 detached 看门狗：父进程死了它照样活。 */
function armWatchdog(id, delaySec) {
  recordPending(id);
  try {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "probe-watchdog.cjs"), id, String(delaySec)], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (e) {
    console.error("[watchdog] 拉起失败，仅依赖进程内取消:", e.message);
  }
}

let activationId = null;
let cancelling = false;

/** 保证取消：不成功就一直重试（直到 MAX_HOLD_SEC）。 */
async function forceCancel(reason) {
  if (!activationId || cancelling) return;
  cancelling = true;
  console.log(`\n[cancel] 开始取消 ${activationId}（原因：${reason}）`);
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < MAX_HOLD_SEC * 1000) {
    attempt += 1;
    const r = await call({ action: "setStatus", id: activationId, status: "8" });
    const sec = Math.round((Date.now() - started) / 1000);
    console.log(`[cancel] #${attempt} (+${sec}s) → ${r}`);
    if (r.startsWith("ACCESS_CANCEL")) {
      console.log(`[cancel] ✅ 已取消（重试 ${attempt} 次）`);
      forgetPending(activationId);
      activationId = null;
      return;
    }
    if (r.includes("NO_ACTIVATION")) {
      console.log("[cancel] 该号上游已结束，无需取消");
      activationId = null;
      return;
    }
    if (r.includes("EARLY_CANCEL_DENIED")) {
      await sleep(15000);
      continue;
    }
    if (r.startsWith("ERR:")) {
      await sleep(5000);
      continue;
    }
    console.log(`[cancel] ⚠️ 未知响应，继续重试：${r}`);
    await sleep(5000);
  }
  console.log(`[cancel] ❌ ${MAX_HOLD_SEC}s 内未能取消，请立刻人工处理 ${activationId}`);
}

/**
 * 同步取消：用 child_process 起一个独立的同步请求。
 *
 * 为什么不能用 async：实测被 timeout/kill 强杀时，async 信号处理器和 finally
 * 都可能来不及跑完，号码就留在上游（647300503 就是这样漏的）。
 * spawnSync 是阻塞的，不会被事件循环打断。
 */
function syncCancel(id) {
  if (!id) return;
  try {
    const { spawnSync } = require("child_process");
    const code = [
      "const https=require('https');",
      "const qs=new URLSearchParams({api_key:process.env.__GK,action:'setStatus',id:process.env.__GID,status:'8'}).toString();",
      "https.get('https://api.grizzlysms.com/stubs/handler_api.php?'+qs,(s)=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{process.stdout.write(d.trim());process.exit(0)})}).on('error',()=>process.exit(1));",
    ].join("");
    const r = spawnSync(process.execPath, ["-e", code], {
      env: { ...process.env, __GK: KEY, __GID: id },
      encoding: "utf8",
      timeout: 20000,
    });
    const out = (r.stdout || "").trim();
    console.log(`[signal] 同步取消 ${id} → ${out || "(无响应)"}`);
  } catch (e) {
    console.error("[signal] 同步取消失败:", e.message);
  }
}

/* ------- 任何退出路径都必须取消 ------- */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`\n[signal] 收到 ${sig}，同步取消号码后退出`);
    syncCancel(activationId);
    process.exit(activationId ? 2 : 0);
  });
}
process.on("uncaughtException", (e) => {
  console.error("[uncaught]", e.message);
  syncCancel(activationId);
  process.exit(activationId ? 2 : 0);
});
process.on("exit", () => {
  /* 最后一道：正常退出时若还没取消，同步补一刀 */
  if (activationId) syncCancel(activationId);
});

(async () => {
  if (!KEY) {
    console.error("缺少 GRIZZLY_API_KEY（环境变量或 .env.local）");
    process.exit(1);
  }

  const service = arg("service", "tg");
  const country = arg("country", "any");
  const maxPrice = arg("max", "0.50");
  const holdSec = Number(arg("hold", "5"));

  try {
    console.log("余额（取号前）:", await call({ action: "getBalance" }));

    const got = await call({ action: "getNumber", service, country, maxPrice });
    console.log("getNumber:", got);
    if (!got.startsWith("ACCESS_NUMBER")) {
      console.log("取号失败，无需取消");
      process.exit(1);
    }
    activationId = got.split(":")[1];
    console.log(`✅ 取到号码，activationId = ${activationId}`);

    /*
     * 关键防线：先落盘 + 拉起**独立**看门狗，再开始持有。
     *
     * 为什么不能只靠进程内信号处理器：Windows 上 timeout / taskkill 是硬杀，
     * Node 收不到 SIGTERM/SIGINT，async finally 也来不及跑 —— 实测两次因此漏号。
     * detached 的子进程不随父进程退出而死，是这里唯一可靠的保证。
     */
    armWatchdog(activationId, holdSec + 30);
    console.log(`   已落盘并拉起看门狗（${holdSec + 30}s 后强制取消）`);
    console.log(`   持有 ${holdSec} 秒后自动取消…`);

    /* 探针内容就插在这里（默认什么都不做，只验证取号/取消链路） */
    for (let i = 0; i < holdSec; i += 5) {
      await sleep(Math.min(5000, (holdSec - i) * 1000));
      console.log(`   +${Math.min(i + 5, holdSec)}s  status = ${await call({ action: "getStatus", id: activationId })}`);
    }
  } finally {
    /* 关键：无论上面抛了什么，这里一定取消 */
    await forceCancel("探针结束");
    console.log("余额（取消后）:", await call({ action: "getBalance" }));
  }

  process.exit(activationId ? 2 : 0);
})();
