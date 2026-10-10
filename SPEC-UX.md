# 实现规格 · 接码台 UX 修正（第二轮）

> 唯一实现依据。**上游事实均为 2026-10-10 实测**，不要凭记忆改动。

## 本轮要解决的三个问题（来自老板截图反馈）

1. 取消只有一句 `上游错误: UNKNOWN`，**没有倒计时**，用户不知道什么时候能取消。
2. **地区/国家显示英文**（`USA (#187)`），要显示中文。
3. **服务显示英文**，要显示中文；且**国家+服务一旦都选好，立刻自动出预估价格**（现在必须手点「估价」）。

## 实测上游事实（务必照抄，勿改）

### A. 取消过早的真实错误码
在激活刚建立时调用 `setStatus&status=8`，Grizzly 返回**纯文本**：
```
EARLY_CANCEL_DENIED
```
这个 token **当前不在** `src/lib/grizzly.ts` 的 `ERROR_TOKENS` 里，于是 `parseSetStatus` 走了兜底分支，抛出
`GrizzlyApiError("UNKNOWN")` → `http.ts` 的 `toErrorResponse` 把它变成 `上游错误：UNKNOWN`。**这就是根因。**

### B. 可取消的时间阈值（实测序列，同一个激活）
| 距取号 | `setStatus(8)` 返回 |
|---|---|
| +1s / +16s / +32s / +48s | `EARLY_CANCEL_DENIED` |
| **+64s** | `ACCESS_CANCEL` ✅ |

→ 真实阈值落在 **49~64 秒**之间。取**保守固定值**：**默认 90 秒**（留足余量，覆盖其它服务/国家可能的差异）。
取消成功后 `getStatus` → `STATUS_CANCEL`，且**全额退款**（实测余额 `3.8726 → 4.0026`，退回 $0.13 一分不差）。

### C. 激活结束后再查状态
对已结束的激活调 `getStatus` → `NO_ACTIVATION`（已在映射表里，无需改）。

### D. 国家中文名：**上游直接提供**
`getCountries` 的每项含 `chn` 字段，例如
`{"1":{"id":1,"eng":"Ukraine","rus":"Украина","chn":"乌克兰",...}}`。
`parseCountries` **已经解析了 `chn`**（`GrizzlyCountry.chn?: string`），**只是前端没用**。改成优先 `chn`、回退 `eng`。

### E. 服务中文名：**上游不提供**
`getServicesList` 只返回 `{"services":[{"code":"sk","name":"Skroutz"}]}`，**没有中文列**；
试过 `lang=chn` / `lang=zh` / `language=chn` 均**无效**（返回仍是英文）。
⚠️ 另外注意：**这个列表每次请求的顺序都不一样（被打乱）**，所以必须**确定性排序**后再展示。

## 改动清单（按文件）

### 1. `src/lib/config.ts`
新增可选配置（有默认值，**不要**要求 Vercel 必须配）：
```ts
// 取号后可取消的最短等待秒数（实测 Grizzly 约 60s 拒绝 EARLY_CANCEL_DENIED）
CANCEL_LOCK_SECONDS: numberFromEnv(90, 0),
```
同步在 `.env.example` 里加一行注释说明（可选）。

### 2. `src/lib/grizzly.ts`
- `GrizzlyErrorCode` 增加 `"EARLY_CANCEL_DENIED"`。
- `ERROR_TOKENS` 增加 `["EARLY_CANCEL_DENIED", "EARLY_CANCEL_DENIED"]`（**放在最前**，它是最长的具体 token）。
- 保留 `UNKNOWN` 兜底，但**不要**把未知 token 静默吞掉：`GrizzlyApiError` 已经带 `raw`，确保它被带到响应里（见第 5 条）。

### 3. 新增 `src/lib/service-names.zh.ts`
导出：
```ts
/** 服务中文名映射。键为 Grizzly service code。上游无中文，只能本地维护。 */
export const SERVICE_NAMES_ZH: Record<string, string> = { /* 见下 */ };

/** 取展示名：优先中文词典 → 若上游 name 本身含中日韩字符则原样用 → 否则回退英文 name。 */
export function displayServiceName(code: string, upstreamName: string): string;

/** 取国家展示名：优先 chn → 回退 eng。 */
export function displayCountryName(eng: string, chn?: string): string;
```
`SERVICE_NAMES_ZH` 至少覆盖这些常见 code（其余回退英文，可后续扩充）：
`tg`/`telegram`→Telegram、`wa`/`whatsapp`→WhatsApp、`fb`→Facebook、`ig`→Instagram、
`go`/`google`→Google、`tw`→Twitter/X、`ds`/`discord`→Discord、`lf`/`line`→LINE、`vi`/`viber`→Viber、
`wx`/`wechat`→微信、`tt`/`tiktok`→TikTok、`am`/`amazon`→亚马逊、`nf`/`netflix`→Netflix、
`st`/`steam`→Steam、`pp`/`paypal`→PayPal、`ub`/`uber`→Uber、`dr`→AI Chat、`aa`→任意服务、
`openai`/`chatgpt`→OpenAI、`binance`→币安、`okx`→OKX、`yandex`→Yandex、`vk`→VK、`ozon`→Ozon、
`avito`→Avito、`youtube`→YouTube、`yahoo`→Yahoo、`mail`→邮箱、`twitter`→Twitter/X。
> 注意真实 code 与上述可能不同，**实现时用一次真实 `getServicesList` 的 code 为准**；
> 如果某个 code 不在词典里，必须优雅回退英文，不能显示 undefined/空。

同时**必须**用 `displayServiceName` 处理「上游 name 本身就含中文」的情形（实测列表里存在
`{"code":"zhng","name":"中国民航信息"}`），这类**原样使用**，不要被英文回退覆盖。

### 4. `src/lib/service.ts`
- `PollActivationResult` 增加：
  - `cancelAvailableInSeconds: number`（**剩余**秒数，`<=0` 表示现在就能取消；由 `activation.createdAt + CANCEL_LOCK_SECONDS` 服务端算出，**这样刷新页面也不会丢**）
  - `cancelLockedUntil: string`（ISO 时间戳）
- `cancelActivation`：**先做本地闸门**，再调上游。
  ```ts
  const lockUntil = activation.createdAt.getTime() + getConfig().CANCEL_LOCK_SECONDS * 1000;
  if (Date.now() < lockUntil) {
    throw conflict(ERROR_CODES.CONFLICT, `取号后需等待 ${getConfig().CANCEL_LOCK_SECONDS} 秒才能取消`,
      { retryAfterSeconds: Math.ceil((lockUntil - Date.now()) / 1000) });
  }
  ```
  上游仍返回 `EARLY_CANCEL_DENIED` 时（例如别的服务阈值更高），**不要**冒泡成 UNKNOWN：
  捕获 `GrizzlyApiError` 且 `code === "EARLY_CANCEL_DENIED"` → 返回 409 + 可读中文
  「上游暂不允许取消，请稍后再试」+ `retryAfterSeconds`（给 15 秒重试建议）。

### 5. `src/lib/http.ts`
`GrizzlyApiError` 分支现在只写 `上游错误：${error.code}`。改成带**中文可读文案**的映射表，例如：
```ts
const GRIZZLY_MESSAGE_ZH: Partial<Record<GrizzlyErrorCode, string>> = {
  EARLY_CANCEL_DENIED: "取号后短时间内上游不允许取消，请稍后再试",
  NO_ACTIVATION: "该号码已结束（收到验证码、被取消或已超时退款）",
  NO_NUMBERS: "当前国家/服务暂时没有可用号码，请换个组合试试",
  NO_BALANCE: "上游主账号余额不足，请联系卖家",
  BAD_KEY: "上游密钥无效，请联系卖家",
  SERVICE_UNAVAILABLE_REGION: "上游限制了当前出口地区，请联系卖家",
  SERVICE_PROHIBITED: "该服务被上游禁止销售，请换一个",
  WRONG_MAX_PRICE: "出价低于上游成本，请重新估价",
  BAD_ACTION: "上游接口不支持该操作，请联系卖家",
  BAD_STATUS: "上游拒绝了该状态变更",
};
```
响应 `message` 用中文文案，`details.code` **保留原始英文 code**（便于排障）。
`error.raw` 也放进 `details.upstreamRaw`（截断 200 字符）。

### 6. `src/app/shop/page.tsx`（UI）
- **国家下拉**：显示 `displayCountryName(eng, chn)（#id）`，即 `美国（#187）`。
- **服务下拉**：显示 `displayServiceName(code, name)（code）`。
- **筛选框**：同时匹配中文名、英文名和 code（现在只匹配 name/code）。
- **自动估价**：`country` 与 `service` 都非空时，**用 ~400ms 防抖自动**调用 `/api/sms/price` 并展示；
  「估价」按钮**保留**作为手动刷新（文案改「重新估价」）。
  ⚠️ 防抖要**取消上一次未完成的请求**（用 `AbortController` 或递增序号丢弃过期响应），避免乱序覆盖。
- **取消倒计时**：取号成功后，从 poll 返回的 `cancelAvailableInSeconds` 渲染倒计时（`mm:ss`，本地每秒递减）：
  - 倒计时 > 0：按钮**禁用**，文案 `可取消倒计时 01:12`，旁边灰字说明「上游取号后约 60 秒内不允许取消」
  - 倒计时 = 0：按钮启用，文案 `取消并回补`
  - 服务端返回 409 带 `retryAfterSeconds` 时，把倒计时**重置**为该值，并显示可读提示
- **错误展示**：直接把 `errorMessage()` 的文案显示出来（现在已经是），但**不要**再让 `UNKNOWN` 这种字面量出现——
  由第 5 条保证。

### 7. 类型同步
`src/app/shop/_types.ts` 的 `PollView` 增加 `cancelAvailableInSeconds: number` 与 `cancelLockedUntil: string`。

## 测试（vitest，`npm test` 必须全绿）
在 `src/lib/__tests__/` 下**新增或扩展**：
- `grizzly.test.ts`：`mapGrizzlyError("EARLY_CANCEL_DENIED")` → `"EARLY_CANCEL_DENIED"`；
  `parseSetStatus("EARLY_CANCEL_DENIED")` **抛出** `GrizzlyApiError` 且 code 正确（**不再**是 UNKNOWN）。
- 新增 `service-names.test.ts`：`displayCountryName("Ukraine","乌克兰")==="乌克兰"`、
  无 chn 时回退 eng；`displayServiceName` 命中词典、命中「name 自带中文」、未命中回退英文三种分支。
- `service.test.ts`（若已有则扩展）：`cancelActivation` 在锁定窗口内**不调用上游**就抛 409，
  且 `details.retryAfterSeconds > 0`；窗口外正常调用。
- 保留原有 113 个测试全部通过。

## 门禁（必须自己跑完并贴真实输出）
```
npx tsc --noEmit
npm test
npm run build
```
**不要** git commit、**不要** push、**不要**改 `.env.local` 或任何 `.env*` 文件。

## 完成后回报
1. 三个门禁的真实输出（通过/失败 + 关键行）
2. 改了哪些文件
3. `EARLY_CANCEL_DENIED` 现在返回给前端的**完整 JSON 形状**（贴一个示例）
4. 仍未验证的点（如实说）
