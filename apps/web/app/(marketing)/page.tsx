"use client";

import dynamic from "next/dynamic";
import { Instrument_Serif, IBM_Plex_Mono } from "next/font/google";
import { LenisProvider } from "./lib/lenis";
import { Hero } from "./sections/hero";
import { Unlocks } from "./sections/unlocks";
import { Close } from "./sections/close";

const displayFont = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

const Profile  = dynamic(() => import("./sections/profile").then((m) => m.Profile),   { ssr: false });
const Mechanism = dynamic(() => import("./sections/mechanism").then((m) => m.Mechanism), { ssr: false });
const Compound  = dynamic(() => import("./sections/compound").then((m) => m.Compound),  { ssr: false });
const Featured  = dynamic(() => import("./sections/featured").then((m) => m.Featured),  { ssr: false });

export default function MarketingPage() {
  return (
    <LenisProvider>
      <div
        className={`${displayFont.variable} ${monoFont.variable} relative bg-[#0a0908] text-[#f5f4ee]`}
      >
        {/* Grain — persists across all sections */}
        <div
          className="pointer-events-none fixed inset-0 z-30 opacity-[0.07] mix-blend-overlay"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          }}
          aria-hidden="true"
        />

        {/* Grid — persists across all sections */}
        <div
          className="pointer-events-none fixed inset-0 z-10 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(#f5f4ee 1px, transparent 1px), linear-gradient(90deg, #f5f4ee 1px, transparent 1px)",
            backgroundSize: "96px 96px",
          }}
          aria-hidden="true"
        />

        <Hero />
        <Profile />
        <Mechanism />
        <Compound />
        <Unlocks />
        <Featured />
        <Close />
      </div>
    </LenisProvider>
  );
}
