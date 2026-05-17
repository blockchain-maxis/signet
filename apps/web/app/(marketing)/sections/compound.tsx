"use client";
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SectionLabel } from "../components/section-label";

interface TimelineNode {
  quarter: string;
  label: string;
  tvl: number;
  featured: boolean;
}

const nodes: TimelineNode[] = [
  { quarter: "Q1 '24", label: "DEX",    tvl: 10000,   featured: false },
  { quarter: "Q2 '24", label: "Token",  tvl: 45000,   featured: false },
  { quarter: "Q2 '24", label: "Vault",  tvl: 62000,   featured: false },
  { quarter: "Q3 '24", label: "DEX",    tvl: 120000,  featured: false },
  { quarter: "Q3 '24", label: "Bridge", tvl: 88000,   featured: false },
  { quarter: "Q4 '24", label: "Token",  tvl: 200000,  featured: true  },
  { quarter: "Q1 '25", label: "Vault",  tvl: 340000,  featured: false },
  { quarter: "Q1 '25", label: "DEX",    tvl: 490000,  featured: true  },
  { quarter: "Q2 '25", label: "Bridge", tvl: 650000,  featured: false },
  { quarter: "Q2 '25", label: "Token",  tvl: 780000,  featured: false },
  { quarter: "Q3 '25", label: "Vault",  tvl: 980000,  featured: false },
  { quarter: "Q4 '25", label: "DEX",    tvl: 1300000, featured: true  },
  { quarter: "Q1 '26", label: "Token",  tvl: 1600000, featured: false },
  { quarter: "Q2 '26", label: "Vault",  tvl: 1800000, featured: true  },
];

const edges: [number, number][] = [
  [0, 3],
  [1, 6],
  [3, 7],
  [6, 10],
  [7, 11],
  [11, 13],
];

function fmtTVL(v: number) {
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

function nodeRadius(tvl: number) {
  const min = 12, max = 42;
  return min + ((Math.log(tvl) - Math.log(10000)) / (Math.log(1800000) - Math.log(10000))) * (max - min);
}

export function Compound() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const cntRef = useRef<HTMLSpanElement>(null);
  const tvlRef = useRef<HTMLSpanElement>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
  }, []);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced || window.innerWidth < 768) return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      const track = trackRef.current;
      if (!track) return;

      const totalScroll = track.scrollWidth - window.innerWidth + 128;

      // Initial hidden states
      const nodeEls = track.querySelectorAll<HTMLElement>("[data-node]");
      gsap.set(nodeEls, { opacity: 0, scale: 0.6 });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: wrapperRef.current,
          start: "top top",
          end: `+=${totalScroll + window.innerHeight}`,
          pin: true,
          scrub: 1,
          anticipatePin: 1,
          onUpdate(self) {
            const prog = self.progress;
            // Move playhead
            if (playheadRef.current) {
              playheadRef.current.style.left = `${4 + prog * 88}%`;
            }
            // Counter
            const visibleCount = Math.round(prog * nodes.length);
            const tvl = prog * 4.2;
            if (cntRef.current) cntRef.current.textContent = String(Math.min(14, visibleCount));
            if (tvlRef.current) tvlRef.current.textContent = `$${tvl.toFixed(1)}M`;
          },
        },
      });

      // Horizontal scroll
      tl.to(track, { x: -totalScroll, ease: "none", duration: 1 }, 0);

      // Nodes pop in as playhead passes
      nodeEls.forEach((el, i) => {
        const pos = (i / nodes.length) * 0.9;
        tl.to(el, { opacity: 1, scale: 1, duration: 0.04 }, pos);
      });
    }, wrapperRef);

    return () => ctx.revert();
  }, [isMobile]);

  if (isMobile) {
    return (
      <section className="relative px-4 py-28">
        <div className="mb-12">
          <SectionLabel>04 · Aggregation</SectionLabel>
          <h2
            className="mt-6 text-[42px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Deployments accumulate over time.
          </h2>
          <p className="mt-5 max-w-[480px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
            Every contract a developer deploys, automatically added to their profile. Years of work, visible at a glance.
          </p>
        </div>
        <div className="flex flex-col gap-4">
          {nodes.map((node, i) => (
            <div
              key={i}
              className={`flex items-center gap-4 border px-4 py-3 ${node.featured ? "border-[#8b1a1a]" : "border-[#1f1d19]"}`}
            >
              <div
                className={`h-3 w-3 rounded-full flex-shrink-0 ${node.featured ? "bg-[#c2410c]" : "bg-[#5e5b51]"}`}
              />
              <div className="min-w-0">
                <div className="text-[13px] text-[#f5f4ee]">{node.label}</div>
                <div className="text-[11px] text-[#5e5b51]" style={{ fontFamily: "var(--font-mono)" }}>
                  {node.quarter} · {fmtTVL(node.tvl)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const NODE_GAP = 160;
  const TRACK_W = NODE_GAP * (nodes.length + 1);
  const BASELINE_Y = 220;

  // Y positions for visual rhythm (not data-driven)
  const yOffsets = [0, -40, 20, -20, 40, -50, 10, -30, 20, -10, 30, -40, 0, -20];

  return (
    <section className="relative overflow-hidden" ref={wrapperRef} style={{ height: "100vh" }}>
      {/* Header — stays fixed during pin */}
      <div className="absolute left-0 right-0 top-0 z-10 flex items-start justify-between px-14 pt-20">
        <div>
          <SectionLabel>04 · Aggregation</SectionLabel>
          <h2
            className="mt-6 text-[56px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Deployments accumulate
            <br />
            over time.
          </h2>
          <p className="mt-4 max-w-[420px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
            Every contract a developer deploys, automatically added to their profile. Years of work, visible at a glance.
          </p>
        </div>
        <div
          className="text-right"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <div className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]">Contracts</div>
          <div className="mt-1 text-[32px] font-bold tracking-[-0.02em] text-[#f5f4ee]" style={{ fontFamily: "var(--font-display)" }}>
            <span ref={cntRef}>0</span>
          </div>
          <div className="mt-3 text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]">Cum. TVL</div>
          <div className="mt-1 text-[32px] font-bold tracking-[-0.02em] text-[#f5f4ee]" style={{ fontFamily: "var(--font-display)" }}>
            <span ref={tvlRef}>$0.0M</span>
          </div>
        </div>
      </div>

      {/* Horizontal timeline track */}
      <div
        ref={trackRef}
        className="absolute bottom-0 top-0 flex items-center"
        style={{ width: `${TRACK_W}px`, willChange: "transform" }}
      >
        {/* SVG for connecting edges */}
        <svg
          className="absolute inset-0 h-full"
          width={TRACK_W}
          height={500}
          style={{ top: "50%", transform: "translateY(-50%)" }}
          aria-hidden="true"
        >
          {edges.map(([a, b], i) => {
            const x1 = (a + 1) * NODE_GAP;
            const y1 = BASELINE_Y / 2 + (yOffsets[a] ?? 0);
            const x2 = (b + 1) * NODE_GAP;
            const y2 = BASELINE_Y / 2 + (yOffsets[b] ?? 0);
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#3d3a33"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
            );
          })}
        </svg>

        {/* Nodes */}
        {nodes.map((node, i) => {
          const r = nodeRadius(node.tvl);
          const x = (i + 1) * NODE_GAP;
          const yOff = (yOffsets[i] ?? 0) * 2;
          return (
            <div
              key={i}
              data-node
              className="absolute flex flex-col items-center"
              style={{
                left: x - r,
                top: `calc(50% + ${yOff}px - ${r}px)`,
                willChange: "transform, opacity",
              }}
            >
              <div
                className={`rounded-full border ${node.featured ? "border-[#8b1a1a] bg-[#1a0808]" : "border-[#3d3a33] bg-[#0e0d0b]"}`}
                style={{ width: r * 2, height: r * 2 }}
              />
              <div
                className="mt-2 text-center"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                <div
                  className={`text-[9px] uppercase tracking-[0.18em] ${node.featured ? "text-[#c2410c]" : "text-[#5e5b51]"}`}
                >
                  {node.label}
                </div>
                <div className="text-[8px] text-[#3d3a33]">{node.quarter}</div>
              </div>
            </div>
          );
        })}

        {/* Playhead */}
        <div
          ref={playheadRef}
          className="absolute bottom-0 top-0 w-px bg-[#8b1a1a] opacity-60"
          style={{ left: "4%" }}
          aria-hidden="true"
        />
      </div>
    </section>
  );
}
