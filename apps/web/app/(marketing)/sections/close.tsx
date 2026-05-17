"use client";
import { motion } from "framer-motion";
import { Seal } from "../components/seal";
import { easeSignet } from "../lib/tokens";

export function Close() {
  return (
    <section className="relative flex min-h-[80vh] flex-col items-center justify-center px-4 py-32 text-center">
      {/* Hairline top */}
      <div className="mb-20 w-full border-t border-[#1f1d19]" />

      {/* Seal */}
      <motion.div
        className="relative mx-auto h-[280px] w-[280px]"
        initial={{ opacity: 0, scale: 0.88 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 1.4, ease: easeSignet }}
      >
        <Seal />
      </motion.div>

      {/* Headline */}
      <div className="mt-14 overflow-hidden">
        <motion.h2
          initial={{ y: "105%" }}
          whileInView={{ y: "0%" }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 1, delay: 0.2, ease: easeSignet }}
          className="text-[64px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[80px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Create your record.
        </motion.h2>
      </div>

      {/* Subhead */}
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.8, delay: 0.5, ease: easeSignet }}
        className="mt-7 text-[17px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]"
        style={{ fontFamily: "var(--font-body)" }}
      >
        Sign in with your wallet to claim a profile.
      </motion.p>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.8, delay: 0.7, ease: easeSignet }}
        className="mt-10"
      >
        <a
          href="#"
          className="group inline-flex w-[280px] items-center justify-between bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] focus:outline-none focus:ring-2 focus:ring-[#8b1a1a] focus:ring-offset-2 focus:ring-offset-[#0a0908]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Sign in with your wallet
          <span className="text-[#8b1a1a] transition-transform duration-300 group-hover:translate-x-1 group-hover:text-[#f5f4ee]">
            →
          </span>
        </a>
      </motion.div>

      {/* Footer line */}
      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 1, delay: 1 }}
        className="mt-10 text-[10px] uppercase tracking-[0.24em] text-[#3d3a33]"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        Stellar mainnet · No fees to claim · Open source
      </motion.p>
    </section>
  );
}
