import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import "./globals.css";
import Sidebar from "./components/Sidebar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WatchAir",
  description: "Monitorización respiratoria en tiempo real",
};

// viewportFit: "cover" para poder usar env(safe-area-inset-*) en la barra
// inferior; sin userScalable para no bloquear el zoom del navegador.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f2f1ec",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-full overflow-hidden">
        <SessionProvider>
          <Sidebar />
          <div className="app-content h-full min-w-0 flex-1 overflow-hidden">{children}</div>
        </SessionProvider>
      </body>
    </html>
  );
}
