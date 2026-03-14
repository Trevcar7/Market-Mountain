import type { Metadata } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--font-playfair",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://marketmountainfinance.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: "%s | Market Mountain",
    default: "Market Mountain | Independent Equity Research",
  },
  description:
    "Data-driven equity research, macroeconomic analysis, and disciplined investment frameworks by Trevor Carnovsky.",
  openGraph: {
    siteName: "Market Mountain",
    type: "website",
    url: siteUrl,
    title: "Market Mountain | Independent Equity Research",
    description:
      "Data-driven equity research, macroeconomic analysis, and disciplined investment frameworks by Trevor Carnovsky.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Market Mountain — Independent Equity Research",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@MarketMountain",
    title: "Market Mountain | Independent Equity Research",
    description:
      "Data-driven equity research, macroeconomic analysis, and disciplined investment frameworks.",
    images: ["/opengraph-image"],
  },
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable}`}>
      <body className="min-h-screen flex flex-col overflow-x-hidden">
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
