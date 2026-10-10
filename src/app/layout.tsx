import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grizzly 卡密小铺",
  description: "把 Grizzly SMS 余额切成带面值的卡密，用 LINUX DO Credit 出售，买家站内自助接码。",
};

/** 内联 SVG 图标：不引图标库，避免给升级留债。 */
function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 place-items-center rounded-lg"
        style={{
          background: "linear-gradient(135deg, rgb(var(--brand)), rgb(var(--brand-strong)))",
          boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.25)",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="2" width="18" height="20" rx="3" />
          <path d="M8 7h8M8 11h8M8 15h5" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-wide">Grizzly 卡密小铺</span>
    </span>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <header
          className="sticky top-0 z-30 border-b backdrop-blur"
          style={{
            borderColor: "rgb(var(--line) / var(--line-a))",
            background: "rgb(var(--surface) / 0.86)",
          }}
        >
          <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="transition hover:opacity-85">
              <Logo />
            </Link>
            <div className="flex items-center gap-1 text-sm">
              <Link href="/" className="btn btn-ghost btn-sm">
                首页
              </Link>
              <Link href="/shop" className="btn btn-ghost btn-sm">
                接码台
              </Link>
              <Link href="/admin" className="btn btn-ghost btn-sm">
                管理台
              </Link>
            </div>
          </nav>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>

        <footer
          className="mx-auto max-w-6xl px-4 pb-12 pt-6 text-xs"
          style={{ color: "rgb(var(--fg-faint))" }}
        >
          <div className="divider mb-4" />
          <p>
            卡密余额变动全部走原子条件 UPDATE，每笔流水可审计。遇到问题请保留订单号联系卖家。
          </p>
          <p className="mt-1">
            卡密一经售出不退不换；单次接码失败或取消会按上游规则回补到卡密余额。
          </p>
        </footer>
      </body>
    </html>
  );
}
