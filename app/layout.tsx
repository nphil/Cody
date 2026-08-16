import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono, Noto_Serif_SC, Source_Serif_4 } from "next/font/google";
import { DEFAULT_THEME_ID, THEMES } from "@/lib/theme-catalog";
import "./globals.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

// Display serif pair for the warm-humanistic heading voice: Source Serif 4
// covers latin, Noto Serif SC covers CJK. Both expose CSS variables consumed
// by --font-serif in globals.css.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

const notoSerifSC = Noto_Serif_SC({
  // CJK glyphs are served via unicode-range slices regardless of subset;
  // "latin" satisfies next/font's preloading requirement.
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-noto-serif",
  display: "swap",
});
const themeBootstrap = JSON.stringify(Object.fromEntries(THEMES.map(({ id, mode, preview }) => [id, { mode, background: preview.background }])));

export const metadata: Metadata = {
  title: "omp web",
  description: "Web UI for the oh-my-pi (omp) coding agent",
  // PWA-like behavior on iOS: standalone chrome, no telephone autodetect.
  appleWebApp: {
    capable: true,
    title: "omp web",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
};

// theme-color adapts to light/dark so the browser chrome / iOS status bar
// matches the active theme. `viewportFit: cover` lets us honor safe-area-inset
// (used by DirectoryPicker footer) on notched devices.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FAF9F6",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} ${sourceSerif.variable} ${notoSerifSC.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        {/* Apply the stored theme before first paint so both the UI and browser
            chrome match the user's previous choice without a light-mode flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document,m=${themeBootstrap},t=localStorage.getItem("cody-theme");if(!m[t])t="${DEFAULT_THEME_ID}";d.documentElement.dataset.theme=t;d.documentElement.classList.toggle("dark",m[t].mode==="dark");d.querySelectorAll('meta[name="theme-color"]').forEach(function(e){e.setAttribute("content",m[t].background)})}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var l=localStorage.getItem("omp-lang");if(l!=="en"&&l!=="zh-CN"&&l!=="ja"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh-CN":n.indexOf("ja")===0?"ja":"en"}document.documentElement.lang=l}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
