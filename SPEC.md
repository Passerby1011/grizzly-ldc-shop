# 实现规格书 · grizzly-ldc-shop

> 本文件是给编码代理（Codex）的唯一实现依据。**已核实的上游事实**都写在下面，不要凭记忆猜测接口。

## 目标

Vercel 上的 Next.js 应用：卖家把 Grizzly SMS 余额切成带面值的「卡密」，用 LINUX DO Credit（LDC）出售；
买家拿卡密在站内自助接码，实时扣费、支持取消回补。

## 已核实的上游事实（2026-10-10 实测，勿改）

### Grizzly SMS Client API
- 基址：`https://api.grizzlysms.com/stubs/handler_api.php`，**全部 GET**，每个请求带 `api_key`（服务端专属）。
- `action=getBalance` → 纯文本 `ACCESS_BALANCE:4.1326`（美元）
- `action=getCountries` → JSON `{"1":{"id":1,"eng":"Ukraine",...,"visible":1,"retry":1},"10":{...}}`
- `action=getServicesList` → JSON `{"services":[{"code":"sk","name":"Skroutz"},...]}`
- `action=getNumbersStatus&country=<id>` → JSON `{"telegram_0":20,"aa_1":100,...}`（键=服务_运营商，值=可用数量）
- `action=getNumber&service=<code>&country=<id|any>&maxPrice=<num>` →
  - 成功纯文本 `ACCESS_NUMBER:<激活ID>:<号码>`
  - 错误：`BAD_KEY` / `NO_BALANCE` / `NO_NUMBERS` / `SERVICE_UNAVAILABLE_REGION` / `The service is prohibited for sale by administration`
- `action=setStatus&id=<id>&status=<1|3|6|8>` → 纯文本
  - `1`=ACCESS_READY（就绪）`3`=ACCESS_RETRY_GET（请求重发）`6`=ACCESS_ACTIVATION（**完成，正式扣费**）`8`=ACCESS_CANCEL（**取消，退款**）
- `action=getStatus&id=<id>` → `STATUS_WAIT_CODE` | `STATUS_WAIT_RETRY:<code>` | `STATUS_WAIT_RESEND` | `STATUS_CANCEL` | `STATUS_OK:<code>`
- `action=getStatusV2&id=<id>` → JSON（含短信全文/来电）
- `action=getActiveActivations` → JSON 活跃激活数组；无激活时返回 `null`
- ⚠️ **`getPrices` / `getPricesV2` / `getPricesV3` 在该 host 实测返回 `BAD_ACTION`**。价格必须走 `PriceProvider`：
  1. 先试 `getPrices` 系列，遇 `BAD_ACTION` 静默降级；
  2. 回退本地 `PriceCache` 表（由真实成交成本回填 + 管理端手填）；
  3. `getNumber` 必须带 `maxPrice` 上限，杜绝超支。

### LINUX DO Credit（易支付兼容协议）
- 基址：`https://credit.linux.do/epay`
- 签名：取**所有非空**请求参数，**排除 `sign`、`sign_type`**，按参数名 ASCII 升序拼 `k1=v1&k2=v2`，末尾**直接追加** `LDC_KEY`，整体 **MD5 取小写十六进制**。
  ```
  payload = "money=10&name=Test&out_trade_no=M20250101&pid=001&type=epay"
  sign    = md5(payload + LDC_KEY).toLowerCase()
  ```
- 下单：`POST /epay/pay/submit.php`（`application/x-www-form-urlencoded`）
  参数 `pid, type=epay, out_trade_no, name(≤64), money(≤2位小数), notify_url?, return_url?, sign, sign_type=MD5`
  成功 → **302 跳转** `https://credit.linux.do/paying?order_no=...`；失败 → 返回 JSON 错误。
  ⚠️ 实测：`sign` 错误时返回 **HTTP 401**。
- 查询：`GET /epay/api.php?act=order&pid=&key=&out_trade_no=`
  成功 `{code:1,...,"status":1}`（1=成功，0=失败/处理中）；订单不存在 → **HTTP 404** + `{"code":-1,"msg":"订单不存在或已完成"}`（实测已确认 pid/key 被受理）。
- 退款：`POST /epay/api.php` `{pid, key, trade_no, money}` —— **仅支持全额退回已成功订单**，`money` 须等于原额。
- 异步通知：**HTTP GET** 到 `notify_url`，字段 `pid, trade_no, out_trade_no, type, name, money, trade_status=TRADE_SUCCESS, sign`
  必须返回 **HTTP 200 且响应体为 `success`**（大小写不敏感），否则平台重试最多 5 次。

## 目录与文件（全部在 `src/` 下）

```
src/lib/config.ts          环境变量读取 + 校验（zod），单例
src/lib/grizzly.ts         Grizzly 客户端：全部 action、错误映射、超时、重试
src/lib/ldc.ts             LDC 客户端：epaySign/verifyNotify/createOrder/queryOrder/refund
src/lib/keycodec.ts        卡密生成/解析/哈希（SHA-256），格式 GS-XXXX-XXXX-XXXX-XXXX（Crockford base32，无易混字符）
src/lib/money.ts           金额工具：Decimal 安全运算、向上取整到 2 位小数、美元↔LDC 换算（纯函数）
src/lib/ledger.ts          账本：原子预扣/实扣/回补/预留释放（Prisma $queryRaw 条件更新）、幂等
src/lib/pool.ts            池核算：真实余额 − 已售未消耗 − 缓冲 = 可用实时池
src/lib/idempotency.ts     幂等键读写 + 内存锁 + 可选 Upstash 锁
src/lib/http.ts            统一 JSON 响应、错误码、请求体校验辅助
```

### API 路由（App Router `src/app/api/**/route.ts`，全部 Node runtime）
| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pay/create` | POST | 入参 `{faceUsd}` → 建 Order(pending) → 签名 → 返回 LDC 收银台跳转 URL |
| `/api/pay/notify` | GET | LDC 回调：验签 → 金额比对 → 幂等入账 → 发卡密 → 返回 `success` |
| `/api/pay/query` | GET | 入参 `outTradeNo` → 主动查 LDC 兜底补单 |
| `/api/key/session` | POST | 入参 `{code}` → 校验卡密 → 返回 `{maskedCode, balanceUsd}` 并落 HttpOnly 签名 Cookie |
| `/api/catalog/countries` | GET | 国家列表（缓存） |
| `/api/catalog/services` | GET | 服务列表（缓存） |
| `/api/catalog/availability` | GET | `?country=` → getNumbersStatus |
| `/api/sms/price` | GET | `?service=&country=` → PriceProvider 估价 + 可用性 |
| `/api/sms/get` | POST | 预扣 → getNumber → 写 Activation → 差额退回；返回 `{activationId, phone, reservedUsd}` |
| `/api/sms/status` | GET | `?activationId=` → 代理 getStatus，命中 `STATUS_OK` 时写库并返回验证码 |
| `/api/sms/cancel` | POST | `{activationId}` → setStatus(8) → 回补 |
| `/api/me/activations` | GET | 当前卡密的激活列表 |
| `/api/admin/keys` | POST | `Bearer ADMIN_TOKEN`；`{faceUsd, count}` → 生成卡密（含池预留校验） |
| `/api/admin/keys` | GET | 列表（不含明文） |
| `/api/admin/overview` | GET | 余额、已售未消耗、可用池、订单与激活统计 |
| `/api/admin/reconcile` | POST | 手动触发对账 |
| `/api/cron/reconcile` | GET | `Authorization: Bearer CRON_SECRET`；对账 + 快照 + 漂移告警 |

### 前端页面（`src/app/**`，Tailwind，简洁可用即可）
- `/` 首页：套餐面值列表（$1/$3/$5/$10，金额由 `RATE_LDC_PER_USD` 换算）→ 点购买跳 LDC
- `/shop` 接码台：贴卡密 → 选国家/服务 → 估价 → 获取号码 → **每 4 秒轮询状态** → 显示验证码 → 可取消
- `/admin` 管理台：口令进入，展示余额/池/订单/卡密/对账按钮

## 账本铁律（必须严格实现）
1. **禁止先读后写**。扣费只允许：
   ```ts
   const rows = await prisma.$queryRaw`
     UPDATE "CardKey" SET "balanceUsd" = "balanceUsd" - ${cost}
     WHERE id = ${id} AND status = 'active' AND "balanceUsd" >= ${cost}
     RETURNING "balanceUsd"`;
   if (rows.length === 0) throw new InsufficientBalance();
   ```
2. 取号流程：先按 `maxPrice` **上限预扣** → getNumber → 成功后按真实成本**退回差额**；失败（NO_NUMBERS/NO_BALANCE 等）**全额退回**。
3. 取消：`setStatus(8)` 成功后才回补；同时把 `Activation.status` 置 `cancelled`。
4. 每笔余额变动**必写一条 `KeyLedger`**，含 `balanceAfter`。
5. 发卡密（回调入账）必须幂等：`outTradeNo` 唯一 + 事务内检查 Order 状态；重复回调直接返回 `success`。
6. 生成卡密前校验可用池：`可用 = 真实余额 − 已售未消耗 − SAFETY_BUFFER_USD`，不足则 409。

## 测试（vitest，`npm test` 必须全绿）
- `money.test.ts`：LDC↔USD 换算、向上取整、边界（0、极小值、精确 2 位）
- `ldc.test.ts`：MD5 签名与文档示例一致；验签通过/被篡改拒绝
- `keycodec.test.ts`：生成→哈希→校验往返；格式与非法输入拒绝
- `grizzly.test.ts`：响应解析（ACCESS_NUMBER / STATUS_OK / 各错误码）→ 结构化结果
- `ledger.test.ts`：用内存假实现验证「余额不足拒绝」「差额退回」「取消回补」语义

## 交付标准
1. `npm run typecheck` 无错误
2. `npm test` 全绿
3. `npm run build` 成功（`prisma generate` 需能跑；DATABASE_URL 允许是占位符）
4. 不提交任何密钥；`.env.example` 只有占位符
5. `README.md` 写清架构、Vercel 部署步骤（Neon + Upstash + 环境变量 + cron）、已知缺口

## 已知缺口（如实写在 README）
- 上游价格接口在该 host 返回 `BAD_ACTION`，估价走本地缓存，首次成交后回填。
- Grizzly 无 webhook，收码依赖前端轮询。
- Vercel 出口 IP 是否被 `SERVICE_UNAVAILABLE_REGION` 拦截**未验证**。
