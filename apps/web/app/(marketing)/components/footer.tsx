'use client';
import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { SignetMonogram } from './signet-monogram';
import { colors } from '../lib/tokens';
import { STELLAR_NETWORK_NAME } from '@/lib/network';

const links = [
  { href: '/', label: 'Home' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/handles', label: 'Handles' },
  { href: '/p/aquawolf', label: 'Demo' },
];

/**
 * Site footer for the marketing page. Logo + one-line thesis on one side;
 * the nav links and the claim CTA sit together on the other, so the footer
 * reads as one more chance to act, not a legal-notice afterthought.
 */
export function Footer() {
  const root = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: root,
    offset: ['start end', 'end end'],
  });
  // Small and slow on purpose — depth, not motion. Mirrors the seal/hero
  // parallax elsewhere on the page rather than introducing a new idiom.
  const wordmarkY = useTransform(scrollYProgress, [0, 1], ['6%', '0%']);

  return (
    <footer
      ref={root}
      className="relative isolate overflow-hidden border-t border-[#1f1d19] bg-[#0a0908] px-8 pt-14 md:px-14"
    >
      <div className="relative z-10 mx-auto w-full max-w-[1480px]">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          {/* Logo side */}
          <div>
            <a href="/" className="group flex items-center gap-3">
              <SignetMonogram className="h-6 w-6 text-[#f5f4ee]" />
              <span
                className="text-[15px] font-medium tracking-tight text-[#f5f4ee]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Signet
              </span>
            </a>
            <p className="mt-3 max-w-xs text-[13px] leading-[1.7] text-[#8a8779]">
              A verifiable developer career record for Stellar/Soroban — every contract
              you&apos;ve deployed, proven on-chain.
            </p>
          </div>

          {/* CTA + links, side by side */}
          <div className="flex flex-wrap items-center gap-x-10 gap-y-5">
            <nav
              className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[11px] uppercase tracking-[0.22em] text-[#8a8779]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="transition-colors hover:text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b1a1a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <a
              href="/#claim"
              className="group text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b1a1a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0908]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <span className="border-b border-[#8b1a1a] pb-1">Claim yours</span>
              <span className="ml-1.5 inline-block text-[#8b1a1a] transition-transform duration-300 group-hover:translate-x-1">
                →
              </span>
            </a>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] py-4 text-[10px] uppercase tracking-[0.22em] text-[#3d3a33]">
          <span>Stellar Community Fund · 2026</span>
          <span>Stellar {STELLAR_NETWORK_NAME.toLowerCase()} · demo</span>
        </div>
      </div>

      {/*
        The wordmark. Sized in vw so it spans edge to edge at any width,
        cropped by the footer's bottom edge, and faded upward with a mask so
        it reads as a printed ground rather than a line of copy.
        aria-hidden because "Signet" is already announced above — this is
        texture, not content.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none relative -z-10 mt-6 select-none overflow-hidden"
      >
        <motion.span
          className="block whitespace-nowrap text-center font-bold leading-[0.78]"
          style={{
            y: wordmarkY,
            color: colors.ink,
            opacity: 0.07,
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2.5rem, 12vw, 12rem)',
            letterSpacing: '0.09em',
            maskImage: 'linear-gradient(to bottom, transparent, black 55%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 55%)',
          }}
        >
          SIGNET
        </motion.span>
      </div>
    </footer>
  );
}
