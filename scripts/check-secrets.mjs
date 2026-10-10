#!/usr/bin/env node
// 提交前密钥扫描：一旦发现疑似真实密钥或 .env 类文件被暂存，直接阻断提交。
// 本脚本只含通用规则，不写入任何真实密钥值。
import { execFileSync } from "node:child_process";

const ALLOW = new Set([".env.example"]);

function staged() {
  // execFileSync + 参数数组：不经过 shell，文件名中的元字符不会被解释
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function stagedContent(file) {
  try {
    return execFileSync("git", ["show", `:${file}`], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch {
    return "";
  }
}

const problems = [];
const files = staged();

for (const f of files) {
  const base = f.split("/").pop() ?? f;
  const isEnvLike = /^\.env($|\.)/.test(base) || base.endsWith(".env");
  if (isEnvLike && !ALLOW.has(base)) {
    problems.push(`${f}: .env 类文件禁止入库（仅允许 .env.example）`);
    continue;
  }
  if (/(\.pem|\.p12|\.key|id_rsa)$/i.test(base)) {
    problems.push(`${f}: 私钥类文件禁止入库`);
    continue;
  }

  const body = stagedContent(f);
  if (!body) continue;

  // 64 位十六进制串（本项目的厂商密钥形态）
  if (/[0-9a-f]{64}/i.test(body)) {
    problems.push(`${f}: 疑似 64 位十六进制密钥`);
  }
  // 赋值给敏感变量的**带引号字面量**（避免把 zod 声明如 `z.string()` 误判）
  const secretAssign = /(GRIZZLY_API_KEY|LDC_KEY|LDC_PID|LDC_PRIVATE_KEY_B64|ADMIN_TOKEN|CRON_SECRET|UPSTASH_REDIS_REST_TOKEN)\s*[=:]\s*["']([^"'\s]{16,})["']/g;
  for (const m of body.matchAll(secretAssign)) {
    const v = m[2];
    // 测试夹具常见写法：标记词可能出现在任意位置（如 a-very-long-admin-token-for-tests）
    if (/(your_|change_me|test|dummy|fake|sample|example|placeholder|localhost|xxx)/i.test(v)) continue;
    if (/^env\(|^\$\{|^process\.env/.test(v)) continue;
    problems.push(`${f}: ${m[1]} 出现疑似真实值`);
  }
  // DATABASE_URL 只在出现真实口令形态时报（localhost / 占位符放行）
  const dbUrl = body.match(/DATABASE_URL\s*[=:]\s*["']([^"'\s]{16,})["']/);
  if (dbUrl && !/(localhost|@host|:5432\/db|user:pass|USER:PASSWORD)/i.test(dbUrl[1])) {
    problems.push(`${f}: DATABASE_URL 出现疑似真实连接串`);
  }
  // 常见 token 前缀
  if (/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,})\b/.test(body)) {
    problems.push(`${f}: 疑似平台 Token`);
  }
}

if (problems.length) {
  console.error("\n✖ 提交被阻断 —— 检测到疑似密钥：\n");
  for (const p of problems) console.error("  - " + p);
  console.error("\n如确认是误报，请调整 scripts/check-secrets.mjs 规则，不要用 --no-verify 绕过。\n");
  process.exit(1);
}
console.log("✔ 密钥扫描通过（" + files.length + " 个暂存文件）");
