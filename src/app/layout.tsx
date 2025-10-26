import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Issue Estimator",
  description: "Generate cost estimates for GitHub issues with GPT-5",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-slate-200 bg-white">
            <div className="container max-w-4xl flex items-center justify-between py-4">
              <Link
                href="/"
                className="text-base font-semibold text-slate-900"
              >
                Issue Estimator
              </Link>
              <nav className="flex items-center gap-4 text-sm text-slate-600">
                <Link href="/" className="hover:text-slate-900">
                  Home
                </Link>
                <Link href="/settings" className="hover:text-slate-900">
                  Settings
                </Link>
              </nav>
            </div>
          </header>
          <div>{children}</div>
        </div>
      </body>
    </html>
  );
}
