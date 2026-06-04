import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import { BottomNav } from "@/components/BottomNav";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SuiPredict-AI | Autonomous DeepBook Predict",
  description:
    "Autonomous AI agents that supply PLP liquidity, trade Predict binaries, and run settlement keepers on Sui.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#050508",
  width: "device-width",
  initialScale: 1,
  // R45 audit fix: drop `maximumScale: 1` + `userScalable: false`.
  // Pinning the zoom to 1x blocks pinch-zoom for low-vision users
  // (a WCAG 1.4.4 violation: "users should be able to resize text
  // up to 200% without loss of content or functionality"). iOS
  // Safari treats `userScalable: false` as "ignore user zoom",
  // and a low-vision user trying to read a small print on the
  // markets page would have no way to scale the text. The
  // R44 audit flagged this; the original `maximumScale: 1` was
  // carried over from a pre-launch "disable zoom on form
  // inputs" pattern that no longer applies (modern iOS no
  // longer auto-zooms focused inputs). Keep `initialScale: 1`
  // so the page renders at the natural zoom on first load.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased pb-16 md:pb-0`}
      >
        <Providers>
          <Nav />
          <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8">{children}</main>
          <BottomNav />
        </Providers>
        <Toaster 
          theme="dark" 
          toastOptions={{
            style: {
              background: 'rgba(5, 5, 8, 0.95)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              backdropFilter: 'blur(12px)',
            }
          }} 
        />
      </body>
    </html>
  );
}
