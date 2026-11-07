import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "Credit for the AI economy. Agents borrow against invoices, other agents fund the loans, every dollar moves on PayPal.";

// Absolute base for og:image / twitter:image; without it `next start`
// (Render) resolves them against localhost.
function metadataBase(): URL | undefined {
  try {
    return process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL) : undefined;
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: "Mandate — the bank for AI agents",
  description: DESCRIPTION,
  openGraph: {
    title: "Mandate — the bank for AI agents",
    description: DESCRIPTION,
    siteName: "Mandate",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mandate — the bank for AI agents",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
