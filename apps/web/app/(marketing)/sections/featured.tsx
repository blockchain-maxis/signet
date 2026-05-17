"use client";
import { useState } from "react";
import { SectionLabel } from "../components/section-label";

interface Profile {
  handle: string;
  contracts: number;
  tvl: string;
  score: number;
  initials: string;
}

const profiles: Profile[] = [
  { handle: "aquawolf", contracts: 12, tvl: "$4.2M", score: 82, initials: "AW" },
  { handle: "nimbus",   contracts: 8,  tvl: "$1.8M", score: 71, initials: "NB" },
  { handle: "pythia",   contracts: 23, tvl: "$11M",  score: 94, initials: "PY" },
  { handle: "vector",   contracts: 5,  tvl: "$890K", score: 64, initials: "VX" },
  { handle: "meridian", contracts: 17, tvl: "$6.3M", score: 87, initials: "MD" },
  { handle: "atlas",    contracts: 9,  tvl: "$2.7M", score: 76, initials: "AT" },
];

// Triple the array for seamless loop
const marqueeProfiles = [...profiles, ...profiles, ...profiles];

function ProfileCard({ profile }: { profile: Profile }) {
  return (
    <div
      className="group relative mx-3 w-[280px] flex-shrink-0 border border-[#3d3a33] bg-[#0a0908] p-6 transition-all duration-300 hover:border-[#5e5b51]"
      style={{ height: "180px" }}
    >
      {/* Verified dot top-right */}
      <div className="absolute right-4 top-4 h-2 w-2 rounded-full bg-[#8b1a1a] transition-colors duration-300 group-hover:bg-[#c2410c]" />

      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div className="relative">
          <svg viewBox="-24 -24 48 48" className="h-12 w-12" aria-hidden="true">
            <polygon
              points="0,-20 17.3,-10 17.3,10 0,20 -17.3,10 -17.3,-10"
              fill="none"
              stroke="#3d3a33"
              strokeWidth="1"
            />
            <text
              textAnchor="middle"
              y="5"
              fontSize="11"
              fill="#b8b5a8"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {profile.initials}
            </text>
          </svg>
        </div>
        <div>
          <div
            className="text-[13px] uppercase tracking-[0.18em] text-[#f5f4ee]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            @{profile.handle}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {[
          { label: "contracts", val: String(profile.contracts) },
          { label: "TVL",       val: profile.tvl },
          { label: "score",     val: String(profile.score) },
        ].map(({ label, val }) => (
          <div key={label}>
            <div
              className="text-[16px] font-bold tracking-[-0.02em] text-[#f5f4ee]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {val}
            </div>
            <div
              className="text-[9px] uppercase tracking-[0.18em] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Featured() {
  const [paused, setPaused] = useState(false);

  return (
    <section className="relative overflow-hidden py-28">
      {/* Section header */}
      <div className="mb-14 px-4 md:px-14">
        <SectionLabel>06 · Active profiles</SectionLabel>
        <h2
          className="mt-6 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Currently indexed.
        </h2>
        <p className="mt-5 max-w-[480px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
          A sample of profiles aggregated from active Soroban deployers.
        </p>
      </div>

      {/* Marquee */}
      <div
        className="relative"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* Fade edges */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24"
          style={{ background: "linear-gradient(90deg, #0a0908 0%, transparent 100%)" }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24"
          style={{ background: "linear-gradient(270deg, #0a0908 0%, transparent 100%)" }}
          aria-hidden="true"
        />

        <div
          className="flex"
          style={{
            animation: "marquee-scroll 40s linear infinite",
            animationPlayState: paused ? "paused" : "running",
            width: `${marqueeProfiles.length * 298}px`,
          }}
        >
          {marqueeProfiles.map((profile, i) => (
            <ProfileCard key={i} profile={profile} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes marquee-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-${profiles.length * 298}px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .marquee-track { animation: none !important; }
        }
      `}</style>
    </section>
  );
}
