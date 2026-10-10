import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grizzly 卡密小铺",
  description: "把 Grizzly SMS 余额切成带面值的卡密，用 LINUX DO Credit 出售，买家站内自助接码。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="border-b border-slate-800">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="text-sm font-semibold tracking-wide text-slate-100">
              Grizzly 卡密小铺
            </Link>
            <div className="flex items-center gap-4 text-sm text-slate-400">
              <Link href="/" className="hover:text-slate-100">
                首页
              </Link>
              <Link href="/shop" className="hover:text-slate-100">
                接码台
              </Link>
              <Link href="/admin" className="hover:text-slate-100">
                管理台
              </Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-10 pt-4 text-xs text-slate-500">
          卡密余额变动全部走原子条件 UPDATE，每笔流水可审计。遇到的问题请保留订单号联系卖家。
        </footer>
      </body>
    </html>
  );
}
