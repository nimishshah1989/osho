import type { Metadata } from "next";
import { Inter, Noto_Sans_Devanagari } from "next/font/google";
import Script from "next/script";
import "../styles/globals.css";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";
import { GA_ID } from "../lib/analytics";
import { PwaRegistrar } from "../components/PwaRegistrar";
import { DesktopGate } from "../components/DesktopGate";
import { OfflineProvider } from "../lib/search/OfflineProvider";

// Gates the cross-origin Google Analytics tags out of the offline
// desktop build (DESKTOP_BUILD=true at `next build`). Evaluated at
// build time so the scripts are simply absent from the static export.
const IS_DESKTOP = process.env.DESKTOP_BUILD === 'true';

const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter" });

// Inter has no Devanagari glyphs; without a dedicated Devanagari webfont the
// browser falls back to whatever the user's OS provides (Mangal on Windows,
// Devanagari MT on Mac, varies on Linux), producing inconsistent and sometimes
// broken glyphs for marks like ्. Loading Noto Sans Devanagari guarantees a
// consistent, well-shaped rendering for every reader.
const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-devanagari",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Osho Discourse Search — Every Word, Verbatim",
  description: "Search and explore the complete discourses of Osho. Every word in Osho's own voice — no paraphrasing, no AI.",
  manifest: "/manifest.webmanifest",
  themeColor: "#1a1410",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Osho",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

// Inline script runs before React hydration to avoid flash of wrong theme.
const themeScript = `
try {
  var t = localStorage.getItem('osho:theme');
  if (t === 'light') {
    document.documentElement.classList.remove('dark');
  } else {
    document.documentElement.classList.add('dark');
  }
} catch(e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <title>Osho Discourse Search — Every Word, Verbatim</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} ${notoDevanagari.variable} font-sans`}>
        {/* Analytics is omitted from the desktop build — it's an offline
            app, so there's nothing to phone home to (and no network). */}
        {!IS_DESKTOP && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga-init" strategy="afterInteractive">{`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_ID}', { send_page_view: false });
            `}</Script>
          </>
        )}
        <ThemeProvider>
          <LocaleProvider>
            <OfflineProvider>
              <DesktopGate>{children}</DesktopGate>
            </OfflineProvider>
          </LocaleProvider>
        </ThemeProvider>
        <PwaRegistrar />
      </body>
    </html>
  );
}
