"use client";
import { motion } from "framer-motion";
import { Seal } from "../components/seal";
import { ConnectWallet } from "../components/connect-wallet";
import { easeSignet } from "../lib/tokens";

export function Close() {
  return (
    <section className="relative flex min-h-[80vh] flex-col items-center justify-center px-4 py-12 text-center">
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
      <div className="overflow-hidden">
        <motion.h2
          initial={{ y: "105%" }}
          whileInView={{ y: "0%" }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 1, delay: 0.2, ease: easeSignet }}
          className="text-[64px] font-bold leading-[0.96] text-white tracking-[-0.025em] text-[#f5f4ee] md:text-[80px]"
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
        <ConnectWallet
          variant="cta"
          className="group inline-flex items-center gap-3 bg-[#f5f4ee] px-7 py-4 text-[12px] font-medium uppercase tracking-[0.18em] text-[#0a0908] transition-all duration-300 hover:bg-[#c2410c] hover:text-[#f5f4ee] disabled:opacity-60"
        />
      </motion.div>
    </section>
  );
}
