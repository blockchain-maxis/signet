"use client";
import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { Seal } from "../components/seal";
import { SignetMonogram } from "../components/signet-monogram";

export function Hero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll();

  const sealScrollRotate = useTransform(scrollY, [0, 1000], [0, 40]);
  const sealScale = useTransform(scrollY, [0, 600], [1, 0.94]);
  const sealOpacity = useTransform(scrollY, [0, 600], [1, 0.5]);
  const heroFade = useTransform(scrollY, [0, 500], [1, 0.3]);

  return (
    <div
      ref={containerRef}
      className="relative min-h-screen overflow-hidden"
    >
      {/* Vignette — hero only */}
      <div
        className="pointer-events-none fixed inset-0 z-20"
        style={{
          background:
            "radial-gradient(ellipse 80% 70% at 50% 45%, transparent 0%, transparent 40%, #0a0908 100%)",
        }}
      />

      {/* Nav */}
      <nav className="relative z-40 flex items-center justify-between px-8 py-7 md:px-14 md:py-9">
        <a href="#" className="group flex items-center gap-3">
          <SignetMonogram className="h-6 w-6 text-[#f5f4ee]" />
          <span className="text-[15px] font-medium tracking-tight">Signet</span>
        </a>
        <div
          className="hidden gap-9 text-[11px] uppercase tracking-[0.22em] text-[#8a8779] md:flex"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <a href="#" className="transition-colors hover:text-[#f5f4ee]">
            Manifesto
          </a>
          <a href="#" className="transition-colors hover:text-[#f5f4ee]">
            Registry
          </a>
          <a href="#" className="transition-colors hover:text-[#f5f4ee]">
            Docs
          </a>
          <a href="#" className="transition-colors hover:text-[#f5f4ee]">
            GitHub
          </a>
        </div>
        <a
          href="#"
          className="text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="border-b border-[#8b1a1a] pb-1">Sign in</span>
          <span className="ml-1.5 text-[#8b1a1a]">→</span>
        </a>
      </nav>

      {/* Hero */}
      <motion.section
        style={{ opacity: heroFade }}
        className="relative z-10 mx-auto grid max-w-[1480px] grid-cols-1 items-center gap-12 px-8 pb-32 pt-8 md:min-h-[calc(100vh-220px)] md:grid-cols-[1.15fr_1fr] md:gap-10 md:px-14 md:pb-16 md:pt-4 lg:gap-20"
      >
        {/* LEFT — copy */}
        <div className="relative">
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center gap-3 text-[11px] uppercase tracking-[0.26em] text-[#8a8779]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b1a1a] opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" />
            </span>
            Stellar
            <span className="text-[#3d3a33]">/</span>
            Soroban
            <span className="text-[#3d3a33]">/</span>
            <span className="text-[#5e5b51]">Mainnet</span>
          </motion.div>

          <h1
            style={{ fontFamily: "var(--font-display)", fontWeight: 700, lineHeight: "0.96", letterSpacing: "-0.025em" }}
            className="mt-12 text-[58px] text-[#f5f4ee] md:text-[78px] lg:text-[104px]"
          >
            <span className="block overflow-hidden">
              <motion.span
                initial={{ y: "105%" }}
                animate={{ y: "0%" }}
                transition={{ duration: 1, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
                className="block"
              >
                Verifiable proof
              </motion.span>
            </span>
            <span className="block overflow-hidden">
              <motion.span
                initial={{ y: "105%" }}
                animate={{ y: "0%" }}
                transition={{ duration: 1, delay: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="block"
              >
                of every contract
              </motion.span>
            </span>
            <span className="block overflow-hidden pt-2 md:pt-4">
              <motion.span
                initial={{ y: "105%" }}
                animate={{ y: "0%" }}
                transition={{ duration: 1, delay: 0.42, ease: [0.16, 1, 0.3, 1] }}
                className="block text-[#b8b5a8]"
              >
                you&apos;ve shipped.
              </motion.span>
            </span>
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="mt-12 max-w-[460px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]"
            style={{ fontFamily: "var(--font-body)" }}
          >
            Signet aggregates every Soroban contract a developer has deployed
            into a public, citable record. Used by grant programs, audit firms,
            and protocols to assess deployer history.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1, ease: [0.16, 1, 0.3, 1] }}
            className="mt-12 flex flex-wrap items-center gap-5"
          >
            <a
              href="#"
              className="group inline-flex items-center gap-3 bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Create your profile
              <span className="text-[#8b1a1a] transition-transform duration-300 group-hover:translate-x-1 group-hover:text-[#f5f4ee]">
                →
              </span>
            </a>
            <a
              href="#"
              className="group inline-flex items-center gap-2.5 px-1 py-4 text-[12px] uppercase tracking-[0.18em] text-[#b8b5a8] transition-colors hover:text-[#f5f4ee]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              <span className="border-b border-[#3d3a33] pb-1 transition-colors group-hover:border-[#f5f4ee]">
                Browse the registry
              </span>
              <span className="text-[#5e5b51]">↗</span>
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 1.4 }}
            className="mt-16 flex items-center gap-5 text-[10px] uppercase tracking-[0.24em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <span className="h-px w-10 bg-[#3d3a33]" />
            {/* TODO(signet): wire to live counts via tRPC */}
            <span>1,247 profiles · 38,402 contracts indexed</span>
          </motion.div>
        </div>

        {/* RIGHT — the seal */}
        <motion.div
          style={{ scale: sealScale, opacity: sealOpacity }}
          className="relative mx-auto flex aspect-square w-full max-w-[340px] items-center justify-center md:max-w-[560px] md:justify-self-end"
        >
          <Seal scrollRotate={sealScrollRotate} />
        </motion.div>
      </motion.section>

      {/* Status bar */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.6 }}
        className="absolute bottom-0 left-0 right-0 z-30 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14"
      >
        <div
          className="flex items-center gap-7 text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="flex items-center gap-2.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b1a1a] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" />
            </span>
            Network · live
          </span>
          <span className="hidden md:inline">Ledger&nbsp;51,284,917</span>
        </div>
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[#3d3a33]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Stellar Community Fund · 2026
        </div>
      </motion.div>
    </div>
  );
}
