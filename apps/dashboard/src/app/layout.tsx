import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lead Research Factory",
  description: "Prompt-driven lead research control dashboard"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
