import type { Metadata } from "next";
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
      <body>{children}</body>
    </html>
  );
}
