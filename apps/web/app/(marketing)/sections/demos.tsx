"use client";
import { motion } from "framer-motion";
import { SectionLabel } from "../components/section-label";
import { easeSignet } from "../lib/tokens";

const profiles = [
  {
    handle: "aquawolf",
    name: "Aqua Wolf",
    desc: "Blend Protocol — create_collateral",
    tag: "DeFi · Lending",
  },
  {
    handle: "sorobuilder",
    name: "Soro Builder",
    desc: "Soroswap — swap_exact_input_single_hints",
    tag: "DEX · AMM",
  },
  {
    handle: "stellardev",
    name: "Stellar Dev",
    desc: "USDC — token transfer",
    tag: "Tokens · Payments",
  },
];

export function Demos() {
  return (
    <section className="relative border-t border-[#1f1d19] px-4 py-28 md:px-14">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.2 }}
        transition={{ duration: 0.8, ease: easeSignet }}
        className="mb-12"
      >
        <SectionLabel>Live demo · Real on-chain data</SectionLabel>
        <h2
          className="mt-6 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          See it in action.
        </h2>
        <p
          className="mt-5 max-w-[480px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]"
          style={{ fontFamily: "var(--font-body)" }}
        >
          Real Stellar wallets. Real Soroban invocations. Each profile is pulled live from
          the public Horizon API.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {profiles.map((p, i) => (
          <motion.a
            key={p.handle}
            href={`/p/${p.handle}`}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, delay: i * 0.08, ease: easeSignet }}
            className="group block border border-[#1f1d19] bg-[#0a0908] p-6 transition-all duration-300 hover:border-[#3d3a33] hover:bg-[#0e0d0b]"
          >
            <div className="mb-4 flex items-center justify-between">
              <span
                className="text-[9px] uppercase tracking-[0.24em] text-[#8b1a1a]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {p.tag}
              </span>
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
            </div>

            <div
              className="text-[22px] font-bold tracking-[-0.02em] text-[#f5f4ee]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {p.name}
            </div>
            <div
              className="mt-1 text-[11px] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              @{p.handle}
            </div>

            <div
              className="mt-4 text-[12px] text-[#8a8779] leading-[1.6]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {p.desc}
            </div>

            <div
              className="mt-6 text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-transform duration-300 group-hover:translate-x-1"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              View profile →
            </div>
          </motion.a>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.8, delay: 0.4, ease: easeSignet }}
        className="mt-8 flex items-center gap-4"
      >
        <a
          href="/how-it-works"
          className="text-[11px] uppercase tracking-[0.22em] text-[#8a8779] transition-colors hover:text-[#f5f4ee]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="border-b border-[#3d3a33] pb-1">How Signet works</span>
          <span className="ml-1.5">↗</span>
        </a>
      </motion.div>
    </section>
  );
}
