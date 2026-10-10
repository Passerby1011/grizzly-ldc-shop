# 实现规格 · Wave 2（后台设置 + 卡密管理 + UI 重做 + 真中文名）

> 唯一实现依据。上游事实均为 2026-10-10 实测，勿改。
> Wave 1（取消倒计时 / 自动估价 / 错误码中文化 / service-names 骨架）**已完成并验收通过**（127 测试全绿），本轮在其之上继续。

## 背景：老板的 5 条反馈与本轮的对应关系

| 老板原话 | 本轮做什么 |
|---|---|
| 1. Grizzly 没有中文，照搬它网页上的 | 用实测 code→中文名词典（`service-names.zh.ts` 扩充） |
| 2. 后台没有管理卡密的功能 | 新增卡密管理（生成/列表/作废/导出） |
| 3. UI 非常丑陋 | 整站视觉重做 |
| 4. 美元↔LDC 兑换比例没有地方设置 | 新增设置面板（存 DB，可热改） |
| 5. 锁定时长可以后台自定义 | 同一个设置面板 |

**关键设计决定：4 和 5 必须落库到 `Setting` 表并优先于环境变量。**
理由：Vercel 上改环境变量要重新部署；老板要的是「在后台点一下就能改」。
读取优先级必须是 **DB 设置 > 环境变量 > 硬编码默认值**。

## 一、数据模型（`prisma/schema.prisma` 新增）

```prisma
/// 可热改的站点设置（优先于环境变量）
model Setting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

迁移用 `prisma db push` 即可（新表，非破坏性）。**注意：本机 `.env.local` 里的 `DATABASE_URL` 是真实 Neon 库，跑 push 前先确认只新增表。**

设置项键名与语义（值都以字符串存）：

| key | 默认（等同环境变量回退） | 说明 |
|---|---|---|
| `rate_ldc_per_usd` | `RATE_LDC_PER_USD`（1.10） | 1 美元 Grizzly 余额卖多少 LDC |
| `markup_pct` | `MARKUP_PCT`（0） | 叠加毛利百分比 |
| `cancel_lock_seconds` | `CANCEL_LOCK_SECONDS`（90） | 取号后可取消的最短等待秒数 |
| `safety_buffer_usd` | `SAFETY_BUFFER_USD`（0.50） | 不可动用的安全缓冲 |
| `face_value_presets` | `1,3,5,10` | 首页面值档位（逗号分隔） |

新增 `src/lib/settings.ts`：
```ts
export interface SiteSettings { rateLdcPerUsd: Decimal; markupPct: number; cancelLockSeconds: number; safetyBufferUsd: Decimal; faceValuePresets: number[]; }
/** 读取顺序：Setting 表 > 环境变量 > 默认。带 30 秒进程内缓存；写后失效。 */
export async function getSiteSettings(): Promise<SiteSettings>;
export async function updateSiteSettings(patch: Partial<...>): Promise<SiteSettings>;
```
**必须通知调用方改这里**：`createPayOrder` 的汇率来源、`pool.ts` 的 `safety_buffer`、`service.ts` 的 `cancelLockSeconds`、首页面值，
全部从 `getSiteSettings()` 取，不要再直接读 `getConfig()` 的这几个字段。

## 二、服务中文名（老板第 1 条）——用实测数据填

**已实测的 Grizzly `getServicesList` 真实 code**（2026-10-10，共 2488 个服务）：

| code | 上游 name | 中文名（用官网叫法） |
|---|---|---|
| `tg` | Telegram | 电报 |
| `wa` | Whatsapp | WhatsApp |
| `go` | Google, Gmail, Youtube | 谷歌 / Gmail / YouTube |
| `ig` | Instagram + Threads | Instagram |
| `fb` | facebook | 脸谱 |
| `lf` | TikTok | TikTok |
| `wb` | WeChat | 微信 |
| `zs` | Bilibili | 哔哩哔哩 |
| `qf` | RedBook (Xiaohongshu (小红书)) | 小红书 |
| `mb` | Yahoo | 雅虎 |
| `ds` | Discord | Discord |
| `dr` | AI Chat | AI 聊天 |
| `vi` | Viber | Viber |
| `tw` | Twitter / X | Twitter / X |
| `am` | Amazon | 亚马逊 |
| `nf` | Netflix | Netflix |
| `ts` | PayPal | PayPal |
| `ub` | Uber | 优步 |
| `mt` | Steam | Steam |
| `aon` | Binance | 币安 |
| `aor` | OKX | OKX |
| `hw` | AliPay | 支付宝 |
| `ab` | Alibaba | 阿里巴巴 |
| `dh` | eBay | eBay |
| `ew` | Nike | 耐克 |
| `nv` | Naver | Naver |
| `gr_sg` | Signal | Signal |
| `tme` | OurTime | OurTime |
| `btc` 等 crypto 类 | — | 保持英文 |

**规则（写进 `displayServiceName`）**：
1. 先查 `SERVICE_NAMES_ZH[code]`；
2. 若上游 `name` **本身含 CJK**（实测有 52 个，如 `btx = Amap 高德地图`、`blo = SiliconFlow 硅基流动`），**原样用上游 name**；
3. 否则回退上游英文 `name`；
4. **绝不**出现 `undefined` 或空串。

> 允许我在数据文件里补更全的词典，但实现必须保证上面 4 条兜底语义。
> 词典的权威来源已抓取并解析过，可参考 `data/service-names.zh.json`（若为空可忽略），真实 code 以上表为准。

## 三、后台（老板第 2/4/5 条）

### API（全部要求 `Authorization: Bearer <ADMIN_TOKEN>`）
| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/admin/settings` | GET | 返回 5 项设置（含「当前生效值」与「环境变量回退值」便于对照） |
| `/api/admin/settings` | PUT | 改设置，写 Setting 表并失效缓存；**必须 zod 校验**（汇率>0、锁定 0~3600、缓冲≥0、presets 正整数数组） |
| `/api/admin/keys` | GET | 卡密列表，**分页**（`?page=&pageSize=`，默认 20，上限 100），支持 `?status=`；**绝不返回明文**，只返回 `codePrefix`、面值、余额、状态、创建时间 |
| `/api/admin/keys` | POST | 生成卡密：`{faceUsd, count(1~100), note?, expiresInDays?}`。**沿用现有 `pool.ts` 的池校验（可用 = 真实余额 − 已售未消耗 − 缓冲），不足返回 409** |
| `/api/admin/keys/[id]` | PATCH | 作废 / 恢复：`{status: "active"|"revoked"}`。作废必须**释放池预留**（`PoolReservation.released=true`），且把剩余余额转出账本记一条 `manual` |
| `/api/admin/keys/[id]/code` | POST | **重新展示明文**（仅当 `code` 仍在 24h 展示窗口内）。这是唯一能再次看到明文的入口，**必须记审计流水**；窗口过期返回 410 |
| `/api/admin/orders` | GET | 订单列表（分页 + 状态筛选） |
| `/api/admin/activations` | GET | 激活记录列表（分页 + 状态筛选，显示成本） |
| `/api/admin/ledger` | GET | 卡密流水（分页，可按 keyId 过滤） |
| `/api/admin/export` | GET | `?type=keys\|orders\|activations`，导出 **CSV**（带 UTF-8 BOM，Excel 直接打开不乱码） |

**管理员鉴权**：现在只有 `requireBearer`。新增 `src/lib/admin.ts` 的 `requireAdmin(request)`，
**同时支持** `Authorization: Bearer <token>` 与 `glc_admin` HttpOnly Cookie（登录页用）。
新增 `POST /api/admin/login`（校验口令 → 下发 Cookie）与 `POST /api/admin/logout`。
口令比对必须走 `constantTimeEqual`。**登录接口要限速**（同 IP 10 次/分钟，用现有 `idempotency.ts` 的内存锁即可）。

### 页面 `/admin`
- **未登录**：只显示口令输入框。
- **已登录**，四个 Tab：
  1. **设置**：汇率 / 毛利 / 锁定时长 / 安全缓冲 / 面值档位；每项下方灰字显示「环境变量回退值」；保存后 toast 提示并显示生效值。
  2. **卡密**：生成表单（面值/数量/备注/有效期）+ 列表表格（分页）+ 每行操作：作废、恢复、展示明文（仅窗口内，弹窗显示并提供复制）。
  3. **订单 / 激活**：分页表格，状态用彩色徽标。
  4. **对账**：余额/池/可用 三个数字 + 最近对账记录 + 「立即对账」按钮。

## 四、UI 重做（老板第 3 条）

**目标：从"能用"变成"好看"。老板明确说过审美他自己不怎么挑，要你自主决定，所以不要来回问，直接做到位。**

技术约束（**必须遵守，勿引入新依赖**）：
- 只用现有 `tailwindcss` + 原生 CSS。**不要**装 shadcn/radix/headless-ui 等新包。
- 图标用**内联 SVG**（不要装图标库）。
- 保持所有现有 API 契约与字段名，**不要改接口形状**，只改表现层。

视觉方向（深色为主，与现有 `globals.css` 一致，可增强）：
- **设计令牌**：在 `globals.css` 用 CSS 变量定义色板（背景/卡片/边框/主色/成功/警告/危险/正文/弱化文本），
  组件只用变量，不写死 hex。主色建议 `indigo/violet` 系，成功 `emerald`，危险 `rose`。
- **层次**：`background` 最深 → `card` 略亮 → 悬浮/选中再亮一档；边框用低透明度白色。
- **圆角**：卡片 16px、按钮 10px、输入 10px；**阴影**用大范围低透明度，不要生硬黑边。
- **字体**：系统字体栈（`ui-sans-serif` 优先），数字用 `tabular-nums`；卡密/验证码用等宽且加大字距。
- **动效**：只做 150~250ms 的过渡（hover、focus、状态切换）；**不要**花哨动画。
- **响应式**：≥1024 三栏/两栏，<640 单栏；表格在小屏改为卡片列表。
- **可访问性**：所有输入有关联 `label`；焦点态有明显 outline；对比度足够（正文 ≥ 4.5:1）；
  按钮有 `disabled` 视觉区分；状态变化用 `aria-live` 播报（验证码到达时）。

具体页面：
1. **`/`（首页）**：Hero 区（一句话说明 + 汇率实时展示「1 USD ≈ X LDC」）+ 面值卡片网格（每张显示面值 USD / 售价 LDC / 购买按钮）+ 三个步骤说明 + 底部合规声明。
2. **`/shop`（接码台）**：把现有 3 个区块改成**带步骤指示的卡片流**。
   - 顶部：当前卡密 + 余额（大字号、毛玻璃感卡片）
   - 步骤 1 选国家（**可搜索下拉**，显示中文名 + 国旗 emoji 可选）
   - 步骤 2 选服务（搜索框 + 列表，显示中文名 + code）
   - 步骤 3 取号 → **倒计时环形/条状进度**（Wave 1 已提供 `cancelAvailableInSeconds`）
   - 步骤 4 验证码展示：**大字号等宽 + 一键复制按钮 + 到达时高亮动画**
   - 所有错误用 `role="alert"` 的醒目条，显示 Wave 1 已做的中文文案
3. **`/admin`**：按上面 Tab 设计，表格支持斑马纹与悬浮高亮。

## 五、首页汇率实时（顺带）
首页需要展示当前汇率与面值售价，必须来自 `getSiteSettings()`，
所以首页要改为**服务端组件**（或在客户端请求一个公开的 `GET /api/site/config` 只返回非敏感项：
汇率、面值档位、锁定时长）。**不要**把 `ADMIN_TOKEN` 等敏感项暴露到公开接口。

## 六、测试（vitest，必须全绿且**不得减少**现有 127 条）
新增：
- `settings.test.ts`：DB 有值时优先于环境变量；无值时回退环境变量；再回退默认；`updateSiteSettings` 后缓存失效。
- `admin-auth.test.ts`：Bearer 通过、Cookie 通过、错误口令拒绝、缺口令 401、`requireAdmin` 常量时间比较被调用。
- `service-names.test.ts`（扩充）：上表真实 code 逐个断言中文名；含 CJK 的上游 name 原样保留；未知 code 回退英文且不返回空。
- `keys-admin.test.ts`：生成卡密走池校验；池不足 409；作废释放预留；列表不含明文。

## 七、门禁（必须自己跑完并贴真实输出）
```
npx tsc --noEmit
npm test
npm run build
```
**不要** git commit / push；**不要**改任何 `.env*`；**不要**跑 `prisma db push`（本轮只改 schema 文件，迁移由我另行执行）。

## 八、完成后回报
1. 三个门禁真实输出
2. 改动/新增文件清单
3. `GET /api/admin/settings` 的响应 JSON 形状（**示例值可假，但键名必须真实**）
4. 术语对照：老板 5 条反馈各自对应的落点
5. **仍未验证的点**（如实说，尤其 UI 未在浏览器手工走查这一点）
