# 贡献指南

## 开发环境

```bash
cp .env.example .env.local     # 填入真实值；此文件已被 .gitignore 排除
npm install
npm run db:push                # 需要可用的 DATABASE_URL
npm run dev
```

## 提交前必跑

```bash
npm run typecheck   # tsc --noEmit，必须 rc=0
npm test            # vitest run，必须全绿
npm run build       # prisma generate && next build
```

四项门禁（含 `npm run lint`）全绿才算完成，不要用"我改的地方没问题"代替跑门禁。

可选安装提交前密钥扫描：

```bash
git config core.hooksPath .githooks
```

## 改代码时请特别注意

本项目**处理真实资金**，以下几类改动风险最高，请附带测试：

1. **任何改变卡密余额的路径**（扣费 / 入账 / 退款 / 手动调整）
   - 必须走 `src/lib/ledger.ts`，**禁止先读后写**
   - 必须写 `KeyLedger` 流水，且与余额改动在同一事务
   - 若改变了余额，必须同步维护 `faceUsd`（保持 `面值 = 余额 + 净消耗`）

2. **任何影响价格的路径**
   - 成交价只能由服务端 `PriceProvider` 决定，**不得接受客户端传入的价格**
   - `PriceCache` 是按 `(service, country)` 唯一的全局共享表，且上游价格接口不可用，
     所以它就是唯一生效的价格来源 —— 不要让不可信的输入写进它
   - 参见 `src/lib/__tests__/price-integrity.test.ts`

3. **退款与幂等**
   - 退款必须用条件 UPDATE 抢占（`waiting → cancelled`），保证重复调用只退一次
   - 新增退款路径前，先确认它和现有路径的口径不冲突
     （三条会动到钱的口径见 README）

4. **改 `prisma/schema.prisma`**
   - 必须对**线上库**也执行 `npx prisma db push`，Vercel 部署不会自动迁移
   - 改完用 `GET /api/admin/overview` 返回 200 自检

5. **新增管理接口**
   - 必须挂 `requireAdmin`（`/api/admin/**` 下没有例外，`login` / `logout` 除外）

## 提交信息

中文，说明**为什么改**而不只是改了什么。如果修复的是资金安全类问题，
写清触发路径与影响面，便于日后回溯。

## 测试风格

优先写**能证伪的断言**：不要只断言"mock 被调用"，要断言真实行为
（金额、状态、事务边界）。已有测试里有不少**源码级回归断言**
（例如"回收路径不得出现 `refund`"），用于钉死修复过的口径，
改动相关代码时不要顺手删掉它们。

## 报告问题

安全问题请走 [SECURITY.md](./SECURITY.md) 的私密渠道，不要开公开 Issue。
