import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "../styles/globals.css";
import { LocaleProvider } from "../lib/i18n";
import { ThemeProvider } from "../lib/theme";

const inter = Inter({ subsets: ["latin", "latin-ext"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Osho Discourse Search — Every Word, Verbatim",
  description: "Search and explore the complete discourses of Osho. Every word in Osho's own voice — no paraphrasing, no AI.",
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
      <body className={`${inter.variable} font-sans`}>
        <ThemeProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
