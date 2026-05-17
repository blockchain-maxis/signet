import type { ReactNode } from "react";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

const display = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${display.variable} ${body.variable} ${mono.variable} min-h-screen bg-[#0a0908] text-[#f5f4ee]`}
    >
      {children}
    </div>
  );
}
