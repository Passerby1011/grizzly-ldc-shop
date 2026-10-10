# 任务 A · 只做设置数据层（禁止碰其它文件）

> **本任务范围极小。只允许创建/修改下面列出的 3 类文件。碰任何其它文件都算失败。**

## 允许改动的文件（仅此）
1. `prisma/schema.prisma` —— 只新增 `Setting` 模型
2. `src/lib/settings.ts` —— 新建
3. `src/lib/__tests__/settings.test.ts` —— 新建
4. `src/lib/service-names.zh.ts` —— 只补词典数据（保留现有导出函数签名不变）
5. `src/lib/__tests__/service-names.test.ts` —— 只扩充断言

**不要**改 config.ts / pool.ts / service.ts / http.ts / 任何 page.tsx / 任何 route.ts / package.json。

## 1) `prisma/schema.prisma` 追加
```prisma
/// 可热改的站点设置（优先于环境变量）
model Setting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

## 2) `src/lib/settings.ts`
```ts
export interface SiteSettings {
  rateLdcPerUsd: Decimal;   // 1 美元 Grizzly 余额卖多少 LDC
  markupPct: number;
  cancelLockSeconds: number;
  safetyBufferUsd: Decimal;
  faceValuePresets: number[];
}
export interface SiteSettingsView {
  effective: SiteSettings;   // 当前生效值
  envFallback: SiteSettings; // 仅环境变量/默认值算出的值，供后台对照
  fromDb: Partial<Record<SettingKey, string>>; // 数据库里显式覆盖了哪些
}
export type SettingKey = "rate_ldc_per_usd" | "markup_pct" | "cancel_lock_seconds" | "safety_buffer_usd" | "face_value_presets";

/** 读取顺序：Setting 表 > 环境变量 > 硬编码默认。进程内缓存 30 秒。 */
export async function getSiteSettings(): Promise<SiteSettings>;
/** 后台用：附带环境变量回退值便于对照。 */
export async function getSiteSettingsView(): Promise<SiteSettingsView>;
/** 局部更新并失效缓存。值以字符串存库。 */
export async function updateSiteSettings(patch: Partial<SiteSettings>): Promise<SiteSettings>;
/** 仅供测试。 */
export function resetSettingsCache(): void;
```

默认值与键名：
| key | 环境变量回退 | 硬编码默认 |
|---|---|---|
| `rate_ldc_per_usd` | `RATE_LDC_PER_USD` | 1.10 |
| `markup_pct` | `MARKUP_PCT` | 0 |
| `cancel_lock_seconds` | `CANCEL_LOCK_SECONDS` | 90 |
| `safety_buffer_usd` | `SAFETY_BUFFER_USD` | 0.50 |
| `face_value_presets` | `FACE_VALUE_PRESETS`（逗号分隔，可选） | `[1,3,5,10]` |

要点：
- 复用 `./money` 的 `dec` / `toStorageString`，不要自己造 Decimal 工具。
- 复用 `./config` 的 `getConfig()` 取环境变量回退值。
- 必须用 `getPrisma()`（`./db`）访问数据库，**这样测试才能 `vi.mock("../db")`**。
- 数据库读失败（表不存在、连不上）**不得抛异常**，要静默回退到环境变量，保证站点在没跑迁移时也能起来。
- 数值非法（负汇率、NaN 等）时回退到环境变量/默认，不要抛。

## 3) `src/lib/service-names.zh.ts` 补全词典
`SERVICE_NAMES_ZH` 至少包含下表（**code 是我实测 `getServicesList` 得到的真实值，不是猜的**）：

```
tg=电报  wa=WhatsApp  go=谷歌/Gmail/YouTube  ig=Instagram  fb=脸谱  lf=TikTok
wb=微信  zs=哔哩哔哩  qf=小红书  mb=雅虎  ds=Discord  dr=AI 聊天  vi=Viber
tw=Twitter / X  am=亚马逊  nf=Netflix  ts=PayPal  ub=优步  mt=Steam
aon=币安  aor=OKX  hw=支付宝  ab=阿里巴巴  dh=eBay  ew=耐克  nv=Naver
gr_sg=Signal  tme=OurTime
```

`displayServiceName(code, upstreamName)` 语义（已是现有实现，**保持不变**）：
1. 词典命中 → 用中文
2. 否则上游 `name` **含 CJK** → 原样用（实测 52 个服务自带中文，如 `btx` = "Amap 高德地图"）
3. 否则回退上游英文 `name`
4. 兜底返回 `code`，**绝不返回空串或 undefined**

## 4) 测试（`npm test` 必须全绿，且现有 127 条一条不能少）
`settings.test.ts`：
- DB 有值时优先于环境变量
- DB 无值时回退环境变量
- DB 与环境变量都无值时回退硬编码默认
- `updateSiteSettings` 后缓存失效（改完再读是新值）
- DB 读取抛错时静默回退，**不抛异常**
`service-names.test.ts` 扩充：上表 code 逐个断言；含 CJK 的上游名原样保留；未知 code 回退英文；空输入不返回空串。

## 门禁（必须自己跑完并贴真实输出）
```
npx tsc --noEmit
npm test
npm run build
```
**不要** `prisma db push`；**不要** git commit / push；**不要**改任何 `.env*`。

## 完成后回报
1. 三个门禁的真实输出
2. 你**实际创建/修改**的文件完整清单
3. `SiteSettingsView` 的 JSON 形状（键名必须真实）
4. 仍未验证的点
