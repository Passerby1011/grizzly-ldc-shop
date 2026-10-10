# grizzly-ldc-shop

把 **Grizzly SMS 余额**切成带面值的「卡密」，用 **LINUX DO Credit（LDC）** 出售；
买家拿卡密在站内自助接码，实时扣费、支持取消回补。

Next.js 15（App Router）+ TypeScript + Prisma（PostgreSQL）+ Tailwind CSS，
部署目标是 Vercel。实现依据是本仓库的 `SPEC.md`。

## 架构

```
src/lib/                       核心库（全部可在 vitest 里单测）
  config.ts      环境变量读取 + zod 校验（单例，惰性求值）
  grizzly.ts     Grizzly 客户端：全部 action、错误映射、超时、重试、PriceProvider
  ldc.ts         LDC 客户端：epaySign / verifyNotify / createOrder / queryOrder / refund
  keycodec.ts    卡密生成/解析/哈希（SHA-256）+ 会话令牌（HMAC）
  money.ts       金额工具（Prisma.Decimal，纯函数）
  ledger.ts      账本：原子条件扣款/入账 + 流水（LedgerStore 抽象）
  pool.ts        池核算 + 发卡 + 回调发货（fulfillPaidOrder）+ 对账
  idempotency.ts 幂等键 + 内存锁 / 可选 Upstash 锁
  http.ts        统一 JSON 响应、错误码、请求体校验、会话 Cookie
  db.ts          PrismaClient 单例
  service.ts     业务编排：下单 / 取号 / 轮询 / 取消 / 查单补发

src/app/api/**   全部路由（Node runtime）
src/app/         /（首页）/shop（接码台）/admin（管理台）
prisma/schema.prisma  数据模型
```

### API 一览

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pay/create` | POST | `{faceUsd}` → 建 Order(pending) → 签名 → 返回 LDC 收银台跳转 URL |
| `/api/pay/notify` | GET | LDC 回调：验签 → 金额比对 → 幂等入账 → 发卡密 → 返回 `success` |
| `/api/pay/query` | GET | `?outTradeNo=` → 主动查 LDC 兜底补单 |
| `/api/key/session` | POST | `{code}` → 校验卡密 → 返回 `{maskedCode, balanceUsd}` 并落 HttpOnly 签名 Cookie |
| `/api/catalog/countries` | GET | 国家列表（进程内缓存 10 分钟） |
| `/api/catalog/services` | GET | 服务列表（进程内缓存 10 分钟） |
| `/api/catalog/availability` | GET | `?country=` → getNumbersStatus（缓存 60 秒） |
| `/api/sms/price` | GET | `?service=&country=` → PriceProvider 估价 + 可用性 |
| `/api/sms/get` | POST | 预扣 → getNumber → 写 Activation → 差额退回 |
| `/api/sms/status` | GET | `?activationId=` → 代理 getStatus，命中 `STATUS_OK` 时写库并返回验证码 |
| `/api/sms/cancel` | POST | `{activationId}` → setStatus(8) → 回补 |
| `/api/me/activations` | GET | 当前卡密的余额 / 激活列表 / 流水 |
| `/api/admin/keys` | POST | `Bearer ADMIN_TOKEN`；`{faceUsd, count}` → 生成卡密（含池预留校验） |
| `/api/admin/keys` | GET | 卡密列表（不含明文） |
| `/api/admin/overview` | GET | 余额、已售未消耗、可用池、订单与激活统计 |
| `/api/admin/reconcile` | POST | 手动触发对账 |
| `/api/cron/reconcile` | GET | `Authorization: Bearer CRON_SECRET`；对账 + 快照 + 漂移告警 |

## 账本铁律（已实现）

1. **禁止先读后写。** 扣费只有一条路径 —— 原子条件 UPDATE：

   ```ts
   UPDATE "CardKey" SET "balanceUsd" = "balanceUsd" - $1::numeric
    WHERE id = $2 AND status = 'active' AND "balanceUsd" >= $1::numeric
    RETURNING "balanceUsd"
   ```

   返回 0 行即余额不足，直接拒绝（`402 INSUFFICIENT_BALANCE`）。
   见 `src/lib/ledger.ts` 的 `createPrismaLedgerStore`。
2. **取号**：先按 `maxPrice` 上限预扣 → `getNumber` → 成功后退回差额；
   失败（`NO_NUMBERS` / `NO_BALANCE` 等）**全额退回**。见 `startActivation`。
3. **取消**：`setStatus(8)` 成功后才回补，同时把 `Activation.status` 置 `cancelled`；
   回补用条件 UPDATE 抢占，重复调用只退一次。见 `cancelActivation`。
4. **每笔余额变动必写一条 `KeyLedger`**，含 `balanceAfter`，且与余额改动在同一事务里。
5. **发卡密幂等**：回调靠 `outTradeNo` 唯一 + 事务内条件更新 `Order.status: pending → paid`，
   重复回调直接返回 `success`。见 `fulfillPaidOrder`。
6. **发卡前校验可用池**：`可用 = 真实余额 − 已售未消耗 − SAFETY_BUFFER_USD`，不足返回 **409**。

## 本地开发

```bash
cp .env.example .env.local     # 填入真实密钥（.env.local 已被 .gitignore 排除）
npm install                    # postinstall 会跑 prisma generate
npm run db:push                # 建表（需要可用的 DATABASE_URL）
npm run dev
```

常用命令：

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # prisma generate && next build
npm run lint
```

提交前密钥扫描（可选安装）：

```bash
git config core.hooksPath .githooks
```

## Vercel 部署

1. **数据库（Neon）**
   - 在 Neon 建库，拿到带 `?sslmode=require` 的连接串。
   - 本地执行 `DATABASE_URL="<neon-url>" npx prisma migrate deploy`（或 `db push`）建表。
2. **Redis（Upstash，可选但推荐）**
   - 建一个 Redis 数据库，拿 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`。
   - 配了这两个变量后，`src/lib/idempotency.ts` 会自动把锁从「进程内」升级成
     「跨实例 Redis 锁」；不配则退化为内存锁（单实例部署够用）。
3. **导入仓库到 Vercel**，框架选 Next.js，构建命令保持默认（`npm run build`）。
4. **环境变量**（Production / Preview 都要配）：

   | 变量 | 说明 |
   |---|---|
   | `GRIZZLY_API_KEY` | Grizzly 服务端专属密钥 |
   | `GRIZZLY_API_BASE` | 默认 `https://api.grizzlysms.com/stubs/handler_api.php` |
   | `LDC_PID` / `LDC_KEY` | LINUX DO Credit 商户号与密钥 |
   | `LDC_API_BASE` | 默认 `https://credit.linux.do/epay` |
   | `DATABASE_URL` | Neon 连接串 |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 可选，配了就启用 Redis 锁 |
   | `ADMIN_TOKEN` | 管理台口令（长随机串） |
   | `RATE_LDC_PER_USD` | 1 美元 Grizzly 余额卖多少 LDC |
   | `MARKUP_PCT` | 附加毛利百分比，叠加在汇率之上 |
   | `SAFETY_BUFFER_USD` | 不可动用的安全缓冲（美元） |
   | `NEXT_PUBLIC_APP_URL` | 站点对外地址（决定 `notify_url` 与 Cookie 的 Secure 标记） |
   | `CRON_SECRET` | Cron 鉴权口令 |

5. **Cron**：仓库根的 `vercel.json` 声明了 `GET /api/cron/reconcile`（**每天 03:00 一次**）。
   Vercel 会自动带 `Authorization: Bearer CRON_SECRET` 调用。

   > ⚠️ **Hobby 套餐限制**：Vercel 免费版每个 cron **每天最多跑 1 次**，写 `0 * * * *` 之类的
   > 更频繁表达式会**直接导致部署被拒**（报错 `Hobby accounts are limited to daily cron jobs`）。
   > 因此仓库里的表达式固定为每日一次。
   >
   > **需要更频繁的对账**（设计目标是 5~15 分钟一次）时，不要改这个表达式升级套餐，
   > 改用**外部定时器**打同一个端点即可（免费）：
   >
   > ```
   > GET https://<你的域名>/api/cron/reconcile
   > Authorization: Bearer <CRON_SECRET>
   > ```
   >
   > 可用 cron-job.org、Upstash QStash 等，间隔设 5~15 分钟。两条路径可以并存，互不冲突。
   > 另注：Hobby 的函数超时上限是 10 秒，该端点只做几次上游查询，正常在 10 秒内完成。
6. **回调地址**：把 `NEXT_PUBLIC_APP_URL` 配成正式域名，`notify_url` 会自动变成
   `https://<域名>/api/pay/notify`，再把它填到 LDC 商户后台。

## 测试

`npm test` 覆盖：

- `money.test.ts`：LDC↔USD 换算、向上取整、边界（0 / 极小值 / 精确 2 位 / 浮点残差）。
- `ldc.test.ts`：MD5 签名与 SPEC 文档示例逐字一致；参数排序、空值剔除；
  验签通过 / 篡改金额 / 篡改签名 / 换密钥全部拒绝；302 与 401 分支。
- `keycodec.test.ts`：生成 → 哈希 → 校验往返；格式正则、Crockford 易混字符回填、非法输入拒绝；会话令牌篡改与过期。
- `grizzly.test.ts`：`ACCESS_NUMBER` / `STATUS_*` / `ACCESS_*` / 各错误码解析；
  `getNumber` 必带 `maxPrice`；PriceProvider 遇 `BAD_ACTION` 静默降级。
- `ledger.test.ts`：内存假实现验证「余额不足拒绝」「差额退回」「取消回补」，
  并断言扣费路径**从不调用只读余额查询**。
- `pool.test.ts`：池可用量公式与超卖（负数）语义。

## 已知缺口（如实说明）

1. **上游价格接口不可用。** `getPrices` / `getPricesV2` / `getPricesV3` 在
   `api.grizzlysms.com` 实测返回 `BAD_ACTION`，因此估价走 `PriceProvider`：
   先试 API → 静默降级到本地 `PriceCache` → 兜底常量（`$0.50`，宁可高估）。
   `PriceCache` 由真实成交成本回填（`source=observed`），管理端也可手填（`manual`）。
   **首次成交前所有估价都是兜底值**，可能偏高；取号成功后会按真实成本退回差额。
2. **Grizzly 没有 webhook。** 收码完全依赖前端每 4 秒轮询 `/api/sms/status`；
   页面关掉就不再轮询（激活记录仍在，重进可继续查）。
3. **Vercel 出口 IP 是否被 `SERVICE_UNAVAILABLE_REGION` 拦截未验证。**
   若线上大量出现该错误，需要换出口（自建代理 / 其他区域函数）。
4. 卡密明文只在「回调发卡 → 订单页」的 24 小时窗口内可取回，过期即从库中抹掉
   （只剩 SHA-256 与前缀）；这是刻意的安全取舍。
5. 对账容差 1 分钱；更大漂移只写记录 + 日志告警，不会自动改账。

## 安全

- **依赖版本底线**：`next >= 15.5.27`。低于此版本受 **CVE-2025-66478（React2Shell，CVSS 10.0，RSC 远程代码执行）**
  影响且官方无绕过方案，必须升级；本项目锁在已修复的 `15.5.27`。
  升级后 Vercel 上的服务端环境变量建议**全部轮换一次**（官方建议，含 `GRIZZLY_API_KEY` / `LDC_KEY` / `ADMIN_TOKEN` / `CRON_SECRET` / 数据库口令）。
- 卡密明文**不落库**，只存 SHA-256（`CardKey.codeHash`）。
- 会话 Cookie 是 HMAC-SHA256 签名的 HttpOnly Cookie，密钥由 `LDC_KEY` 派生。
- 管理接口用 `Authorization: Bearer ADMIN_TOKEN`，比较走常量时间。
- LDC 回调验签（常量时间比较）+ 金额比对，重复回调幂等返回 `success`。
- `.env*` 与私钥文件被 `.gitignore` 排除，`scripts/check-secrets.mjs` 做提交前扫描。
