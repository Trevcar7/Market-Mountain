import type { Metadata, Viewport } from "next";
import { Playfair_Display, Inter } from "next/font/google";
import Script from "next/script";
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8F9FA" },
    { media: "(prefers-color-scheme: dark)", color: "#0A1628" },
  ],
};

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
    types: {
      "application/rss+xml": "/feed.xml",
    },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  other: {
    "google-adsense-account": "ca-pub-6679513715020663",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${playfair.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        {/* Prevent white flash on dark mode — runs before paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("mm-theme");if(t==="dark"||(t==null&&window.matchMedia("(prefers-color-scheme:dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen flex flex-col">
        <Script
          async
          src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6679513715020663"
          crossOrigin="anonymous"
          strategy="afterInteractive"
        />
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
