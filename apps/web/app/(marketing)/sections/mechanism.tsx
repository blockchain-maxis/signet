"use client";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SectionLabel } from "../components/section-label";

const steps = [
  {
    num: "01",
    title: "Connect",
    body: `You sign a structured payload from any Stellar wallet — Freighter, Albedo, Lobstr. The signature includes your profile, the wallet pubkey, a timestamp, a nonce, and the domain. Domain separation matters: a signature meant for Signet can't be replayed elsewhere.`,
    code: `{
  profile_id: "aquawolf",
  wallet:     "GAQUA…WOLF",
  timestamp:  1731234567,
  nonce:      "f7e6c95d0f283b419c",
  domain:     "signet.dev"
}`,
  },
  {
    num: "02",
    title: "Attest",
    body: `The signature is submitted to identity_registry, our Soroban contract on Stellar. The contract verifies the signature against your declared pubkey and writes the binding. Once written, it's append-only — you can't backdate or transfer past work.`,
    code: `identity_registry::attest(
  profile_id: "aquawolf",
  wallet:     GAQUA…WOLF,
  signature:  0x4a8f9c12bd0e3f87…
)`,
  },
  {
    num: "03",
    title: "Index",
    body: `Our indexer subscribes to Stellar's RPC for events from every registered wallet. Every contract you've ever deployed — past and future — is detected and bound to your profile within seconds.`,
    code: null,
  },
  {
    num: "04",
    title: "Compound",
    body: `Your profile updates in real time as you ship. TVL, incidents, attestations, peer endorsements — all aggregated, all derived from on-chain truth. Nothing self-reported. Nothing you can fake.`,
    code: null,
  },
];

function DiagramDot({ active }: { active?: boolean }) {
  return (
    <div
      className={`h-2 w-2 rounded-full ${active ? "bg-[#c2410c]" : "bg-[#3d3a33]"}`}
    />
  );
}

export function Mechanism() {
  const sectionRef = useRef<HTMLElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const stage1Ref = useRef<HTMLDivElement>(null);
  const stage2Ref = useRef<HTMLDivElement>(null);
  const stage3Ref = useRef<HTMLDivElement>(null);
  const stage4Ref = useRef<HTMLDivElement>(null);
  const conn1Ref = useRef<SVGLineElement>(null);
  const conn2Ref = useRef<SVGLineElement>(null);
  const conn3Ref = useRef<SVGLineElement>(null);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.innerWidth < 768;
    if (prefersReduced || isMobile) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      // Set initial connector dash
      const connectors = [conn1Ref.current, conn2Ref.current, conn3Ref.current];
      connectors.forEach((el) => {
        if (!el) return;
        const len = el.getTotalLength?.() ?? 120;
        el.style.strokeDasharray = `${len}`;
        el.style.strokeDashoffset = `${len}`;
      });

      gsap.set([stage1Ref.current, stage2Ref.current, stage3Ref.current, stage4Ref.current], {
        opacity: 0,
        y: 12,
      });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: diagramRef.current,
          start: "top center",
          end: "bottom center",
          scrub: 1,
        },
      });

      // Stage 1 builds at 0–25%
      tl.to(stage1Ref.current, { opacity: 1, y: 0, duration: 0.25 }, 0);

      // Connector 1 draws + stage 2 at 25–50%
      tl.to(conn1Ref.current, { strokeDashoffset: 0, duration: 0.15 }, 0.25);
      tl.to(stage2Ref.current, { opacity: 1, y: 0, duration: 0.2 }, 0.35);

      // Connector 2 draws + stage 3 at 50–75%
      tl.to(conn2Ref.current, { strokeDashoffset: 0, duration: 0.15 }, 0.5);
      tl.to(stage3Ref.current, { opacity: 1, y: 0, duration: 0.2 }, 0.6);

      // Connector 3 draws + stage 4 at 75–100%
      tl.to(conn3Ref.current, { strokeDashoffset: 0, duration: 0.15 }, 0.75);
      tl.to(stage4Ref.current, { opacity: 1, y: 0, duration: 0.2 }, 0.85);
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative px-4 py-28 md:px-14">
      {/* Section header */}
      <div className="mb-20 max-w-5xl">
        <SectionLabel>03 · How it works</SectionLabel>
        <h2
          className="mt-6 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How attestation works.
        </h2>
        <p className="mt-5 max-w-[480px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
          From signature to public profile, in four steps.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-16 md:grid-cols-[1fr_360px] md:gap-20 lg:grid-cols-[1fr_400px]">
        {/* LEFT — scrolling steps */}
        <div className="flex flex-col gap-20">
          {steps.map((step) => (
            <div key={step.num} className="border-l-2 border-[#1f1d19] pl-8">
              <div
                className="mb-3 text-[10px] uppercase tracking-[0.26em] text-[#8b1a1a]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {step.num}
              </div>
              <h3
                className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-[#f5f4ee]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {step.title}
              </h3>
              <p className="mt-4 text-[15px] leading-[1.65] text-[#8a8779]">{step.body}</p>
              {step.code && (
                <pre
                  className="mt-5 overflow-x-auto border border-[#1f1d19] bg-[#0e0d0b] p-4 text-[12px] leading-[1.7] text-[#5e5b51]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {step.code}
                </pre>
              )}
              {step.num === "03" && (
                <div className="mt-5 flex items-center gap-3 text-[11px] text-[#5e5b51]" style={{ fontFamily: "var(--font-mono)" }}>
                  <span className="text-[#8a8779]">Wallet</span>
                  <span className="h-px w-6 bg-[#3d3a33]" />
                  <span>Stellar RPC</span>
                  <span className="h-px w-6 bg-[#3d3a33]" />
                  <span>Indexer</span>
                  <span className="h-px w-6 bg-[#3d3a33]" />
                  <span className="text-[#8a8779]">Profile</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* RIGHT — pinned diagram */}
        <div className="hidden md:block">
          <div className="sticky top-24">
            <div ref={diagramRef} className="flex flex-col items-center gap-0">

              {/* Stage 1: Wallet */}
              <div ref={stage1Ref} className="flex flex-col items-center gap-3">
                <div className="border border-[#3d3a33] bg-[#0e0d0b] p-5">
                  <svg viewBox="-30 -30 60 60" className="h-14 w-14" aria-hidden="true">
                    <polygon points="0,-24 20.8,-12 20.8,12 0,24 -20.8,12 -20.8,-12"
                      fill="none" stroke="#f5f4ee" strokeWidth="1" />
                    <path d="M -8,-10 Q -8,-16 0,-16 Q 8,-16 8,-8 Q 8,0 0,0 Q -8,0 -8,8 Q -8,16 0,16 Q 8,16 8,10"
                      fill="none" stroke="#f5f4ee" strokeWidth="1.6" strokeLinecap="round" />
                    <circle cx="0" cy="0" r="1.5" fill="#8b1a1a" />
                  </svg>
                </div>
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  01 · Wallet signs
                </span>
              </div>

              {/* Connector 1 */}
              <div className="flex flex-col items-center py-2">
                <svg width="2" height="48" aria-hidden="true">
                  <line
                    ref={conn1Ref}
                    x1="1" y1="0" x2="1" y2="48"
                    stroke="#8b1a1a" strokeWidth="1.5"
                    strokeDasharray="48" strokeDashoffset="48"
                  />
                </svg>
              </div>

              {/* Stage 2: Contract */}
              <div ref={stage2Ref} className="flex flex-col items-center gap-3">
                <div className="border border-[#3d3a33] bg-[#0e0d0b] p-5">
                  <svg viewBox="-40 -30 80 60" className="h-14 w-20" aria-hidden="true">
                    <rect x="-36" y="-22" width="72" height="44" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
                    <rect x="-28" y="-14" width="56" height="28" fill="none" stroke="#f5f4ee" strokeWidth="0.8" />
                    <text x="0" y="4" textAnchor="middle" fill="#8a8779"
                      style={{ fontFamily: "var(--font-mono)" }} fontSize="7">
                      id_registry
                    </text>
                    <circle cx="0" cy="-4" r="2" fill="#8b1a1a" opacity="0.8" />
                  </svg>
                </div>
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  02 · On-chain attest
                </span>
              </div>

              {/* Connector 2 */}
              <div className="flex flex-col items-center py-2">
                <svg width="2" height="48" aria-hidden="true">
                  <line
                    ref={conn2Ref}
                    x1="1" y1="0" x2="1" y2="48"
                    stroke="#8b1a1a" strokeWidth="1.5"
                    strokeDasharray="48" strokeDashoffset="48"
                  />
                </svg>
              </div>

              {/* Stage 3: Indexer */}
              <div ref={stage3Ref} className="flex flex-col items-center gap-3">
                <div className="border border-[#3d3a33] bg-[#0e0d0b] p-5">
                  <svg viewBox="-30 -30 60 60" className="h-14 w-14" aria-hidden="true">
                    <circle cx="0" cy="0" r="22" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
                    <circle cx="0" cy="0" r="16" fill="none" stroke="#f5f4ee" strokeWidth="0.8" />
                    <line x1="-22" y1="0" x2="-14" y2="0" stroke="#8b1a1a" strokeWidth="1" />
                    <line x1="14" y1="0" x2="22" y2="0" stroke="#8b1a1a" strokeWidth="1" />
                    <text x="0" y="4" textAnchor="middle" fill="#8a8779"
                      style={{ fontFamily: "var(--font-mono)" }} fontSize="7">
                      IDX
                    </text>
                  </svg>
                </div>
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  03 · Indexer
                </span>
              </div>

              {/* Connector 3 */}
              <div className="flex flex-col items-center py-2">
                <svg width="2" height="48" aria-hidden="true">
                  <line
                    ref={conn3Ref}
                    x1="1" y1="0" x2="1" y2="48"
                    stroke="#8b1a1a" strokeWidth="1.5"
                    strokeDasharray="48" strokeDashoffset="48"
                  />
                </svg>
              </div>

              {/* Stage 4: Profile */}
              <div ref={stage4Ref} className="flex flex-col items-center gap-3">
                <div className="border border-[#3d3a33] bg-[#0e0d0b] p-5">
                  <svg viewBox="-40 -30 80 60" className="h-14 w-20" aria-hidden="true">
                    <rect x="-36" y="-26" width="72" height="52" fill="none" stroke="#f5f4ee" strokeWidth="0.8" />
                    <line x1="-28" y1="-16" x2="28" y2="-16" stroke="#3d3a33" strokeWidth="0.5" />
                    <text x="-28" y="-8" fill="#b8b5a8"
                      style={{ fontFamily: "var(--font-mono)" }} fontSize="6">
                      aquawolf
                    </text>
                    <rect x="-28" y="-2" width="40" height="2" fill="#3d3a33" />
                    <rect x="-28" y="4" width="28" height="2" fill="#3d3a33" />
                    <rect x="-28" y="10" width="50" height="2" fill="#3d3a33" />
                    <circle cx="22" cy="14" r="3" fill="none" stroke="#8b1a1a" strokeWidth="0.8" />
                    <circle cx="22" cy="14" r="1" fill="#8b1a1a" />
                  </svg>
                </div>
                <span
                  className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  04 · Profile updated
                </span>
              </div>

            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
