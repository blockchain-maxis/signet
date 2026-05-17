"use client";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SectionLabel } from "../components/section-label";

const wallets = [
  { key: "GAQUA4XKVYSGWNPVU2K7H6P5L3J8BRDM9NK3FCAQT", display: "GAQUA…WOLF", ts: "2024-03-14 · 09:22 UTC" },
  { key: "GTEAMB2R7NPLK4DXHFM3P8QK9YCVM5J6WTQA2X4", display: "GTEAM…M2X4", ts: "2024-05-02 · 14:47 UTC" },
  { key: "GBKUPR9HKLD3MNTVCW5AXJE7ZQYS5DMKP2FVWP9NK", display: "GBKUP…P9NK", ts: "2024-08-19 · 11:03 UTC" },
];

const timelineNodes = [
  { q: "Q1 '24", label: "DEX",    tvl: 10000,  x: 4  },
  { q: "Q2 '24", label: "Token",  tvl: 45000,  x: 12 },
  { q: "Q2 '24", label: "Vault",  tvl: 62000,  x: 18 },
  { q: "Q3 '24", label: "DEX",    tvl: 120000, x: 26 },
  { q: "Q3 '24", label: "Bridge", tvl: 88000,  x: 32 },
  { q: "Q4 '24", label: "Token",  tvl: 200000, x: 40 },
  { q: "Q1 '25", label: "Vault",  tvl: 340000, x: 48 },
  { q: "Q1 '25", label: "DEX",    tvl: 490000, x: 54 },
  { q: "Q2 '25", label: "Bridge", tvl: 650000, x: 62 },
  { q: "Q2 '25", label: "Token",  tvl: 780000, x: 68 },
  { q: "Q3 '25", label: "Vault",  tvl: 980000, x: 76 },
  { q: "Q4 '25", label: "DEX",    tvl: 1800000, x: 84 },
];

const contracts = [
  { id: "SOR-1A4F", name: "Onyx DEX",     tvl: "$1.8M TVL" },
  { id: "SOR-2B7C", name: "Vector Token", tvl: "$890K" },
  { id: "SOR-3D9E", name: "Lending Vault", tvl: "$1.2M TVL" },
];

const attesters = ["NB", "PY", "VX", "MR", "AT", "KL", "DR", "SW", "JR"];

function fmtTVL(v: number) {
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

export function Profile() {
  const sectionRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  const headerMetaRef = useRef<HTMLDivElement>(null);
  const walletsRef = useRef<HTMLDivElement>(null);
  const tlLineRef = useRef<HTMLDivElement>(null);
  const tlNodesRef = useRef<HTMLDivElement>(null);
  const contractsRef = useRef<HTMLDivElement>(null);
  const attestRef = useRef<HTMLDivElement>(null);
  const trustedRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  const cntContractsRef = useRef<HTMLSpanElement>(null);
  const cntTvlRef = useRef<HTMLSpanElement>(null);
  const cntIncidentsRef = useRef<HTMLSpanElement>(null);
  const cntBountiesRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.innerWidth < 768;
    if (prefersReduced || isMobile) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: `+=${window.innerHeight * 2}`,
          pin: true,
          scrub: 1,
          anticipatePin: 1,
        },
      });

      // Initial hidden states
      gsap.set(nameRef.current?.querySelectorAll("span") ?? [], { opacity: 0, y: 12 });
      gsap.set(headerMetaRef.current?.children ?? [], { opacity: 0, y: 8 });
      gsap.set(walletsRef.current?.children ?? [], { opacity: 0, y: 10, scale: 1.03 });
      gsap.set(tlLineRef.current, { scaleX: 0, transformOrigin: "left center" });
      gsap.set(tlNodesRef.current?.children ?? [], { opacity: 0, scale: 0.5 });
      gsap.set(contractsRef.current?.children ?? [], { opacity: 0, y: 8 });
      gsap.set(attestRef.current, { opacity: 0 });
      gsap.set(trustedRef.current, { opacity: 0 });
      gsap.set(statsRef.current?.children ?? [], { opacity: 0 });

      // 0–15%: name characters
      tl.to(
        nameRef.current?.querySelectorAll("span") ?? [],
        { opacity: 1, y: 0, stagger: 0.04, duration: 0.5 },
        0
      );
      // 10–15%: header meta
      tl.to(
        headerMetaRef.current?.children ?? [],
        { opacity: 1, y: 0, stagger: 0.08, duration: 0.3 },
        0.8
      );

      // 15–30%: wallets
      tl.to(
        walletsRef.current?.children ?? [],
        { opacity: 1, y: 0, scale: 1, stagger: 0.4, duration: 0.35 },
        1.5
      );

      // 30–55%: timeline
      tl.to(tlLineRef.current, { scaleX: 1, duration: 1.2 }, 3);
      tl.to(
        tlNodesRef.current?.children ?? [],
        { opacity: 1, scale: 1, stagger: 0.1, duration: 0.15 },
        3.8
      );

      // 55–75%: featured contracts
      tl.to(
        contractsRef.current?.children ?? [],
        { opacity: 1, y: 0, stagger: 0.3, duration: 0.45 },
        5.5
      );

      // 75–90%: attestations
      tl.to(attestRef.current, { opacity: 1, duration: 0.6 }, 7.5);
      tl.to(trustedRef.current, { opacity: 1, duration: 0.3 }, 8.5);

      // 90–100%: stats count up
      const counter = { c: 0, t: 0, b: 0 };
      tl.to(statsRef.current?.children ?? [], { opacity: 1, duration: 0.2 }, 9);
      tl.to(
        counter,
        {
          c: 12,
          t: 4.2,
          b: 3,
          duration: 1,
          onUpdate() {
            if (cntContractsRef.current) cntContractsRef.current.textContent = String(Math.round(counter.c));
            if (cntTvlRef.current) cntTvlRef.current.textContent = `$${counter.t.toFixed(1)}M`;
            if (cntBountiesRef.current) cntBountiesRef.current.textContent = String(Math.round(counter.b));
          },
        },
        9
      );
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-24 md:px-14"
    >
      {/* Section header */}
      <div className="mb-12 w-full max-w-5xl">
        <SectionLabel>02 · Profile</SectionLabel>
        <h2
          className="mt-6 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          What a profile contains.
        </h2>
        <p className="mt-5 max-w-[520px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
          Every profile aggregates a developer&apos;s linked wallets, deployed contracts, and on-chain activity into a single public record.
        </p>
      </div>

      {/* Profile card */}
      <div
        ref={cardRef}
        className="w-full max-w-5xl border border-[#3d3a33] bg-[#0e0d0b]"
      >
        {/* Header */}
        <div className="border-b border-[#1f1d19] p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3
                ref={nameRef}
                className="text-[42px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee] md:text-[56px]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {"aquawolf".split("").map((char, i) => (
                  <span key={i} className="inline-block">{char}</span>
                ))}
              </h3>
              <div ref={headerMetaRef} className="mt-3 flex flex-wrap items-center gap-4">
                <span
                  className="text-[11px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Signet member since March 2024
                </span>
                <span
                  className="border border-[#3d3a33] px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Verified · Mainnet
                </span>
                <span
                  className="border border-[#8b1a1a] px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#c2410c]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Signet score: 82
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Linked wallets */}
        <div className="border-b border-[#1f1d19] p-6 md:p-8">
          <div
            className="mb-4 text-[10px] uppercase tracking-[0.24em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Linked wallets
          </div>
          <div ref={walletsRef} className="flex flex-col gap-3">
            {wallets.map((w) => (
              <div
                key={w.key}
                className="flex flex-wrap items-center justify-between gap-3 border border-[#1f1d19] bg-[#0a0908] px-4 py-3"
              >
                <span
                  className="text-[13px] text-[#b8b5a8]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {w.display}
                </span>
                <div className="flex items-center gap-4">
                  <span
                    className="text-[10px] text-[#5e5b51]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {w.ts}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    Verified
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Career timeline */}
        <div className="border-b border-[#1f1d19] p-6 md:p-8">
          <div
            className="mb-5 text-[10px] uppercase tracking-[0.24em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Career timeline · 2024–2026
          </div>
          <div className="relative">
            {/* Baseline */}
            <div
              ref={tlLineRef}
              className="h-px w-full bg-[#3d3a33]"
              style={{ transformOrigin: "left center" }}
            />
            {/* Nodes */}
            <div
              ref={tlNodesRef}
              className="relative mt-0 flex items-end"
              style={{ height: "80px" }}
            >
              {timelineNodes.map((node, i) => {
                const maxTVL = 1800000;
                const barH = Math.max(6, Math.round((Math.log(node.tvl) / Math.log(maxTVL)) * 56));
                const isFeatured = node.tvl >= 800000;
                return (
                  <div
                    key={i}
                    className="absolute flex flex-col items-center gap-1"
                    style={{ left: `${node.x}%`, bottom: 0 }}
                  >
                    <span
                      className="text-[8px] text-[#5e5b51]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {node.label}
                    </span>
                    <div
                      className={`w-1 ${isFeatured ? "bg-[#8b1a1a]" : "bg-[#3d3a33]"}`}
                      style={{ height: `${barH}px` }}
                    />
                    <div
                      className={`h-2 w-2 rounded-full ${isFeatured ? "bg-[#c2410c]" : "bg-[#5e5b51]"}`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between">
              <span
                className="text-[9px] text-[#3d3a33]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Q1 2024
              </span>
              <span
                className="text-[9px] text-[#3d3a33]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Q2 2026
              </span>
            </div>
          </div>
        </div>

        {/* Featured contracts */}
        <div className="border-b border-[#1f1d19] p-6 md:p-8">
          <div
            className="mb-4 text-[10px] uppercase tracking-[0.24em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Featured contracts
          </div>
          <div ref={contractsRef} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {contracts.map((c) => (
              <div
                key={c.id}
                className="border border-[#1f1d19] bg-[#0a0908] p-4"
              >
                <div
                  className="text-[10px] text-[#8b1a1a]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {c.id}
                </div>
                <div className="mt-1 text-[14px] text-[#f5f4ee]">{c.name}</div>
                <div
                  className="mt-2 text-[11px] text-[#8a8779]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {c.tvl}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom row: attestations + stats */}
        <div className="grid grid-cols-1 gap-0 md:grid-cols-[1fr_auto]">
          {/* Attestations */}
          <div className="border-b border-[#1f1d19] p-6 md:border-b-0 md:border-r md:p-8">
            <div
              className="mb-4 text-[10px] uppercase tracking-[0.24em] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Peer attestations
            </div>
            <div ref={attestRef} className="flex flex-wrap gap-2">
              {attesters.map((initials, i) => (
                <div
                  key={i}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-[#3d3a33] bg-[#0a0908]"
                >
                  <span
                    className="text-[10px] text-[#8a8779]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {initials}
                  </span>
                </div>
              ))}
            </div>
            <div
              ref={trustedRef}
              className="mt-4 border border-[#8b1a1a] bg-[#0a0908] px-3 py-2 text-[11px] text-[#c2410c]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Trusted by @nimbus
            </div>
          </div>

          {/* Stats */}
          <div ref={statsRef} className="grid grid-cols-2 gap-0">
            {[
              { label: "Contracts", ref: cntContractsRef, val: "12" },
              { label: "Cum. TVL",  ref: cntTvlRef,       val: "$4.2M" },
              { label: "Incidents", ref: cntIncidentsRef,  val: "0" },
              { label: "Bounties paid", ref: cntBountiesRef, val: "3" },
            ].map((stat, i) => (
              <div
                key={i}
                className="flex flex-col justify-center border-b border-l border-[#1f1d19] p-5"
              >
                <span
                  ref={stat.ref}
                  className="text-[28px] font-normal leading-none text-[#f5f4ee]"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {stat.val}
                </span>
                <span
                  className="mt-1.5 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {stat.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
