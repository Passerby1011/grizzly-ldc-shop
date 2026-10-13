# grizzly-ldc-shop

把 **Grizzly SMS 余额**切成带面值的「卡密」，用 **LINUX DO Credit（LDC）** 出售；
买家拿卡密在站内自助接码，实时扣费、支持取消回补。

Next.js 15（App Router）+ TypeScript + Prisma（PostgreSQL）+ Tailwind CSS，部署目标是 Vercel。

> **性质说明**：这是一个**自用型的余额分销工具**，不是通用 SaaS。业务规则
> （汇率、结算、是否退款）由部署者自行决定，代码保留了全部可配置开关。
> 部署前请阅读 [SECURITY.md](./SECURITY.md) 了解资产与威胁模型。

---

## 目录

- [工作原理](#工作原理)
- [架构](#架构)
- [API 一览](#api-一览)
- [资金安全设计](#资金安全设计)
- [本地开发](#本地开发)
- [部署到 Vercel](#部署到-vercel)
- [管理后台](#管理后台)
- [对账](#对账)
- [自动化任务](#自动化任务)
- [测试](#测试)
- [已知缺口](#已知缺口)
- [安全](#安全)
- [许可证](#许可证)

---

## 工作原理

```
买家                      本站                          上游 Grizzly SMS
 │                         │                                  │
 ├─ ① 买卡密 ────────────► │  LDC 收款 → 新建 CardKey          │
 │    （或给已有卡充值）    │  （明文只展示一次，库里只存哈希）  │
 │                         │                                  │
 ├─ ② 贴卡密登录 ────────► │  签名 HttpOnly Cookie 会话        │
 │                         │                                  │
 ├─ ③ 选国家/服务取号 ───► │  按估价预扣 ──────────────────►  getNumber
 │                         │  成功后退回差额                   │
 ├─ ④ 轮询等验证码 ──────► │  代理 getStatus ──────────────►  getStatus
 │                         │  命中 STATUS_OK 时原子认领并写库   │
 └─ ⑤ 取消（可选）───────► │  setStatus(8) 成功后才回补 ────►  setStatus
```

**来自上游的客观约束**（不是设计选择，改代码也绕不过）：

- Grizzly **没有 webhook**，收码只能靠前端轮询。
- 上游价格接口 `getPrices*` 实测恒返回 `BAD_ACTION`，估价只能走本地缓存 + 兜底常量。
- 号码有**有效期**，过期即作废；取消窗口按供应商浮动（实测 64s～334s）。

---

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
  face-value.ts  面值/充值金额规则（唯一校验入口）
  settings.ts    站点设置：DB > 环境变量 > 默认（单一键映射表）
  idempotency.ts 幂等键 + 内存锁 / 可选 Upstash 锁
  http.ts        统一 JSON 响应、错误码、请求体校验、会话 Cookie
  db.ts          PrismaClient 单例
  service.ts     业务编排：下单 / 取号 / 轮询 / 取消 / 核账 / 审计

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
| `/api/pay/quote` | GET | `?faceUsd=` → 服务端算 LDC 金额（避免前后端取整偏差） |
| `/api/key/session` | POST | `{code}` → 校验卡密 → 返回 `{maskedCode, balanceUsd}` 并落 HttpOnly 签名 Cookie |
| `/api/key/topup` | POST | 给**当前登录卡密**充值（目标卡只来自会话，不接受 body 传 ID） |
| `/api/me/activations` | GET | 当前卡密的余额 / 取号历史 / 资金流水 |
| `/api/catalog/countries` | GET | 国家列表（进程内缓存 10 分钟） |
| `/api/catalog/services` | GET | 服务列表（进程内缓存 10 分钟） |
| `/api/catalog/availability` | GET | `?country=<id\|any>` → getNumbersStatus（缓存 60 秒，带条数上限） |
| `/api/sms/price` | GET | `?service=&country=` → PriceProvider 估价 + 可用性 |
| `/api/sms/get` | POST | 预扣 → getNumber → 写 Activation → 差额退回 |
| `/api/sms/status` | GET | `?activationId=` → 代理 getStatus，命中 `STATUS_OK` 时原子认领并返回验证码 |
| `/api/sms/cancel` | POST | `{activationId}` → setStatus(8) → 回补 |
| `/api/site/stock` | GET | 首页「可售余额」（只暴露必要数字，不泄漏经营信息） |
| `/api/admin/*` | — | 管理台接口，**全部** `Bearer ADMIN_TOKEN`（`login` / `logout` 除外） |
| `/api/cron/reconcile` | GET | `Bearer CRON_SECRET`；对账 + 快照 + 漂移告警 |
| `/api/cron/sweep` | GET | `Bearer CRON_SECRET`；保底回收 + 弃单核账 + 明文清理 + 未退款审计 |

---

## 资金安全设计

### 账本铁律

1. **禁止先读后写。** 扣费只有一条路径 —— 原子条件 UPDATE：

   ```sql
   UPDATE "CardKey" SET "balanceUsd" = "balanceUsd" - $1::numeric
    WHERE id = $2 AND status = 'active' AND "balanceUsd" >= $1::numeric
   RETURNING "balanceUsd"
   ```

   返回 0 行即余额不足，直接拒绝（`402 INSUFFICIENT_BALANCE`）。
   见 `src/lib/ledger.ts` 的 `createPrismaLedgerStore`。

2. **取号**：先按上限预扣 → `getNumber` → 成功后退回差额；
   失败（`NO_NUMBERS` / `NO_BALANCE` 等）**全额退回**。见 `startActivation`。

3. **取消**：`setStatus(8)` 成功后才回补，同时把 `Activation.status` 置 `cancelled`；
   回补用条件 UPDATE 抢占，**重复调用只退一次**。见 `cancelActivation`。

4. **每笔余额变动必写一条 `KeyLedger`**，含 `balanceAfter`，且与余额改动**在同一事务里**。

5. **发卡密幂等**：回调靠 `outTradeNo` 唯一 + 事务内条件更新 `Order.status`，
   重复回调直接返回 `success`。见 `fulfillPaidOrder`。

6. **发卡 / 充值前校验可用池**：
   `可用 = 真实余额 − 已售未消耗 − 安全缓冲`，不足返回 **409**。
   新购与充值走**同一道闸门** —— 充值的钱同样会变成上游买号额度。

7. **面值不变量**：`面值 = 余额 + 该卡净消耗`。
   凡改变余额的入口（发卡 / 充值 / 手动调整）都必须同步维护面值，
   否则展示与实际脱节，也会让「扣费未退」审计误报。

### 价格完整性

**客户端不得影响成交价。** `/api/sms/get` 不接受任何价格入参，
价格一律由服务端 `PriceProvider` 决定；且只有服务端估价才会回填价格缓存。

这条很重要：价格缓存 `PriceCache` 按 `(service, country)` 唯一，而上游价格接口不可用，
所以**缓存就是唯一生效的价格来源**。若允许客户端传入价格并回填，任何人用一张自己的卡
就能永久改写某个服务组合的售价，影响所有后续买家。

### 明文不落库

卡密明文**只存 SHA-256**（`CardKey.codeHash`）。唯一例外：发新卡时明文会临时写进
`Order.rawNotify`，供支付回跳页取回一次，**24 小时后由定时任务物理抹除**
（`purgeExpiredCodes`），不依赖是否有人访问。

### 三个会动到钱的口径

| 场景 | 退不退 | 理由 |
|---|---|---|
| 上游自行取消（`STATUS_CANCEL`） | **退** | 上游已把钱退回主账号，号不可能再出码 |
| 弃单核账（买家走开、上游已取消） | **退** | 同上，且有确认窗口防误退 |
| 保底回收（我们主动放弃超时号） | **不退** | 号码已被消耗，买家承担未收到码的风险 |

前两条是资金安全，自动执行；第三条是业务策略，默认关闭、可后台配置。

---

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

---

## 部署到 Vercel

### 1. 数据库（Neon）

在 Neon 建库，拿到带 `?sslmode=require` 的连接串，然后建表：

```bash
DATABASE_URL="<neon-url>" npx prisma db push
```

> ⚠️ **改了 `prisma/schema.prisma` 就必须重新执行这一步。**
> Vercel 部署**不会**自动建表/加列。忘记同步会导致线上接口直接 500
> （例如 `The column X does not exist`），整个管理台不可用。
>
> 部署后自检：带口令打 `GET /api/admin/overview`，**200 才算库结构对得上**。
> 注意对账有降级容错，可能「看起来正常」（返回推算值），
> 所以判断库结构要用 `overview`，不要用对账。

### 2. Redis（Upstash，可选但推荐）

配了 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 后，
`src/lib/idempotency.ts` 会把锁从「进程内」升级成「跨实例 Redis 锁」；
不配则退化为内存锁（单实例部署够用，账本原子扣费不受影响）。

### 3. 导入仓库到 Vercel

框架选 Next.js，构建命令保持默认（`npm run build`）。

### 4. 环境变量

Production / Preview 都要配：

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
| `NEXT_PUBLIC_APP_URL` | 站点对外地址（决定 `notify_url` 与 Cookie 的 `Secure` 标记） |
| `CRON_SECRET` | Cron 鉴权口令 |

### 5. Cron

`vercel.json` 声明了 `GET /api/cron/reconcile`（每天 03:00）与
`GET /api/cron/sweep`（每天 04:00），Vercel 会带 `Authorization: Bearer $CRON_SECRET` 调用。

> ⚠️ **Vercel Hobby 套餐每个 cron 每天最多 1 次**，写更频繁的表达式会
> **直接导致部署被拒**（`Hobby accounts are limited to daily cron jobs`）。
> 需要更高频率时，**不要改表达式**，改用外部定时器打同一个端点（免费）：

```
GET https://<你的域名>/api/cron/sweep
Authorization: Bearer <CRON_SECRET>
```

可用 cron-job.org、Upstash QStash 等，间隔设 5～15 分钟。两条路径可并存。

### 6. 回调地址

把 `NEXT_PUBLIC_APP_URL` 配成正式域名，`notify_url` 会自动变成
`https://<域名>/api/pay/notify`，再把它填到 LDC 商户后台。

---

## 管理后台

`/admin`，口令登录后签发 HttpOnly Cookie（12 小时）。

| 面板 | 能做什么 |
|---|---|
| 概览 / 对账 | 余额核对、差额校准、未退款审计、库存与订单统计 |
| 卡密管理 | 生成（明文只显示一次）、分页列表、作废/恢复、**手动调整额度**、导出 CSV |
| 订单与流水 | 订单（区分买卡/充值）、资金流水（`reserve` / `topup` / `get_number` / `cancel_refund` / `manual`） |
| 设置 | 汇率、毛利、取消锁定、取消重试冷却、安全缓冲、自动回收、面值档位 |

**「手动调整额度」** 用于客服补偿或纠正错账：带符号金额（±1000 上限，两位小数），
走 `ledger.manualAdjust` 写 `manual` 流水 —— 余额变化有据可查，
且对账等式本来就减去 `manual` 合计，因此**不会制造假差额**。
加额会过池容量闸门，并同步面值以维持不变量。

**设置读取优先级**：数据库 > 环境变量 > 硬编码默认。
所有键集中在一张 `SETTING_KEYS` / `KEY_TO_FIELD` 映射表里，新增键只改一处
（历史上有过"读写清单漏键导致后台改了不生效"的 bug）。

---

## 对账

回答一个具体问题：**上游真实余额和本地推算余额，对得上吗？**

```
本地应有余额 = 基准投入 − 净消耗 − 手工调整
差额         = 上游真实余额 − 本地应有余额
```

| 项 | 含义 |
|---|---|
| 基准投入 | 推断的上游初始投入（`ReconcileBaseline` 单行表）。首次按「当前余额 + 净消耗」推断 |
| 净消耗 | **只含真正打到上游的**：取号扣费 − 退回差额 − 取消回补 |
| 手工调整 | `manual` 流水的净额，单列不进净消耗 |

**为什么这么设计（重要）**：反例是 `drift = 真实 − (已售未消耗 + 历史消耗)`，这是错的 ——
「已售未消耗」统计 active 卡密的余额，而**作废 / 恢复卡密是纯本地动作、根本不碰上游**。
作废一张卡那个数就变，对账立刻凭空报出一个差额。那是错误的等式，不是真的漂移。

所以现在：**发卡、充值入账、作废、恢复都不进等式**，只有取号与退回进。
差额只可能来自「我们不知道的上游变动」——手动给 Grizzly 充值、或直接在上游消费。

- 差额超过 1 分钱 → `ok=false` + 中文 message，cron 会告警
- 「校准差额」按钮：把差额并入基准使对账归零。**只改基准，不动任何卡密余额与流水**
- `ReconcileBaseline` 表缺失时降级为「按当前余额推算」并标记 `tableMissing`，
  绝不让整个对账功能挂掉（线上忘记迁移也安全）

### 未退款审计

`auditUnrefundedActivations` 找出「扣了费但没退钱」的激活
（关联流水净额为负、且没有成功出码），挂到后台概览顶部。

它排在**核账之后**执行：先让自动退款把能解决的解决掉，剩下的才需要人工看。
判据用统一公式 `面值 = 余额 + 净消耗`，因此合法卡不会误报。

---

## 自动化任务

`GET /api/cron/sweep` 一次做四件事（顺序有意义）：

| 步骤 | 作用 | 退钱吗 |
|---|---|---|
| `sweepStaleActivations` | 主动回收超时未收到码的号，释放上游库存 | **不退**（业务策略，默认关闭） |
| `reconcileAbandonedActivations` | 核对被遗弃的 `waiting`：上游出码就补记、上游已取消就退款 | **退** |
| `purgeExpiredCodes` | 物理抹除超过 24 小时展示窗口的卡密明文 | — |
| `auditUnrefundedActivations` | 只读检查，把仍对不上的挂到后台 | — |

另有**机会式兜底**：接码台轮询接口会顺带触发核账（同实例 60 秒限流），
所以即使外部定时器没配，只要有人在用站点，弃单也不会长期卡住。

> **公平轮转**：核账按「最久没被检查过」取记录（而非按创建时间），
> 并给每条打 `lastPolledAt` 标记 —— 避免最老的一批长期解析不了时，
> 新的弃单永远轮不到。

### 保底回收（默认关闭）

超过 `autoCancelMinutes` 仍是 `waiting` 的激活会被主动取消，释放上游占用。
**回收成功不退还卡密余额**（号码已被消耗），只调 `setStatus(8)` + 本地置 `expired`，
**绝不写账本**（有源码级测试钉死这条）。

默认 `autoCancelMinutes = 0`（关闭）。需要时在后台改成 16 左右即可生效，无需改代码。

> 实测：上游取消窗口在 64s～334s 之间浮动（按供应商变），16 分钟留了约 3 倍余量；
> `ACCESS_CANCEL` 会把号码费用退回主账号，所以回收本身不亏钱。

### 弃单核账

本地激活状态**只靠买家浏览器轮询更新**。买家一切走（去开第二个号、直接关页面），
轮询就停，本地记录永远冻在 `waiting`，而上游早已出码或取消。

`reconcileAbandonedActivations` 定期核对上游真实状态：

- 上游已出码 → 条件 UPDATE 补记（绝不让买家的码丢掉）
- 上游已取消 → 退款给卡密
- 上游报 `NO_ACTIVATION`（号已消失）→ 同样按取消处理并退款
- 仅网络抖动 → 记 `errors` 留待下轮重试，不误退

**确认窗口**：只有"上游已取消 **且** 距取号超过 N 分钟"才退款，
避免把刚取号、仍处于可取消态的号误判为已结束。

修复过的一个竞态：轮询拿到验证码后一度是「无条件写回 ok 并下发验证码」。
若用户在此期间点了取消（已退款、本地置 `cancelled`），就会**同时拿到退款和验证码**。
现在 `pollActivation` 先用条件 UPDATE 认领（只有仍是 `waiting` 才能变 `ok`），
认领失败就绝不通知上游、绝不下发验证码。核账补记走同一套条件认领。

### 取消重试冷却

上游解锁取消的时机不可预测（按供应商变）。首次取消被拒后，
系统会锁一段时间（默认 150 秒，后台可配）并提示买家到点再试，
而不是让他连点刷上游。锁内请求在本地直接挡掉，不发往上游。

### 余额归零的卡密仍可登录

余额扣到 0 时状态转为 `depleted`：**不能再取号，但仍可登录**充值与查看历史。
这是刻意留的自救通道 —— 若登录也被拒，用户余额花完就再也进不来，连充值都做不到。

---

## 测试

```bash
npm test
```

覆盖：金额换算与边界、LDC 签名/验签/篡改拒绝、卡密编解码与会话令牌、
上游响应解析与错误映射、账本原子性与幂等、池公式、自定义金额规则、
对账等式、核账/审计/回收路径、取消重试冷却、**价格完整性**（客户端不得影响成交价）、
后台鉴权覆盖。

其中相当一部分是**源码级回归断言**（例如「回收路径不得出现 `refund`」
「调整额度必须同步面值」「observe 必须跳过 override 来源」），
用于钉死已经被修复过的资金安全口径，防止回退。

---

## 已知缺口

1. **上游价格接口不可用。** `getPrices*` 实测返回 `BAD_ACTION`，估价走
   `PriceProvider`：试 API → 静默降级到本地 `PriceCache` → 兜底常量（宁可高估）。
   `PriceCache` 只在**服务端估价**时回填（`source=observed`），管理端也可手填（`manual`）。
   首次成交前所有估价都是兜底值，可能偏高。
2. **`Activation.costUsd` 是估价而非上游真实扣费。** 上游不返回成交价，
   所以退款与统计都基于估价。若估价偏高或偏低，差额由站点承担。
3. **Grizzly 没有 webhook。** 收码完全依赖前端每 4 秒轮询；页面关掉就不轮询
   （激活记录仍在，重进可继续查，服务端核账也会兜底收口）。
4. **Vercel 出口 IP 是否被 `SERVICE_UNAVAILABLE_REGION` 拦截因区域而异。**
   若线上大量出现该错误，需要换出口（自建代理 / 其他区域函数）。
5. **LDC 退款接口未接入业务。** `ldc.ts` 有 `refund` 能力，但没有任何业务路径调用它；
   目前所有退款都发生在**内部余额**层面，不涉及把 LDC 退回买家。
6. **管理登录限速是单实例内存的**，多实例部署下会被绕过。
   配了 Upstash 可以加强，但不是内置行为。
7. 对账容差 1 分钱；更大漂移只写记录 + 日志告警，不会自动改账。

---

## 安全

- **依赖版本底线**：`next >= 15.5.27`。低于此版本受
  **CVE-2025-66478（React2Shell，CVSS 10.0，RSC 远程代码执行）** 影响且官方无绕过方案。
  升级后建议**轮换全部服务端密钥**（`GRIZZLY_API_KEY` / `LDC_KEY` / `ADMIN_TOKEN` /
  `CRON_SECRET` / 数据库口令）。
- 卡密明文不长期落库，只存 SHA-256；临时明文 24 小时后由定时任务抹除。
- 会话 Cookie 是 HMAC-SHA256 签名的 HttpOnly Cookie，密钥由 `LDC_KEY` 派生。
- 管理接口统一走 `requireAdmin`（Bearer 或登录 Cookie），常量时间比较口令，
  并有基于 IP 的登录限速。
- LDC 回调验签（常量时间比较）+ 金额比对，重复回调幂等返回 `success`。
- **500 响应一律返回固定文案**，不回显内部异常或数据库报错原文；详情只进服务端日志。
- 畸形 Cookie 不会把受保护接口打成 500（解析带兜底）。
- 对外可见的缓存（如可用号查询）有**条数上限 + 过期清理**，防止内存与上游配额被滥用。
- `.env*` 被 `.gitignore` 排除，`scripts/check-secrets.mjs` 做提交前扫描。

漏洞报告请见 [SECURITY.md](./SECURITY.md)。

---

## 许可证

[MIT](./LICENSE)
