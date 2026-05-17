"use client";
import { motion } from "framer-motion";
import { SectionLabel } from "../components/section-label";
import { easeSignet } from "../lib/tokens";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: easeSignet } },
};

function GrantMockup() {
  return (
    <div className="border border-[#3d3a33] bg-[#0e0d0b]">
      <div className="border-b border-[#1f1d19] px-6 py-4">
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          SCF Application #2849
        </div>
        <div className="mt-1 text-[15px] text-[#f5f4ee]">
          Aquawolf Labs · Soroban DEX Aggregator
        </div>
      </div>
      <div className="p-6">
        <div
          className="mb-4 text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Signet profile · embedded
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Score",    val: "82" },
            { label: "Contracts",val: "12" },
            { label: "TVL",      val: "$4.2M" },
            { label: "Incidents",val: "0" },
          ].map(({ label, val }) => (
            <div key={label} className="border border-[#1f1d19] bg-[#0a0908] p-3">
              <div
                className="text-[22px] font-bold tracking-[-0.02em] text-[#f5f4ee]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {val}
              </div>
              <div
                className="mt-1 text-[9px] uppercase tracking-[0.2em] text-[#5e5b51]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
        <div
          className="mt-5 border border-[#1f1d19] bg-[#0a0908] p-4 text-[12px] leading-[1.6] text-[#8a8779]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Reviewer note: 12 deployments, $4.2M handled, 17 peer attestations, 0 incidents.
        </div>
      </div>
    </div>
  );
}

function AuditMockup() {
  const tiers = [
    { tier: "Standard",         price: "$50,000",  req: "—" },
    { tier: "Verified deployer",price: "$35,000",  req: "≥ 50" },
    { tier: "Trusted deployer", price: "$20,000",  req: "≥ 70" },
  ];
  return (
    <div className="border border-[#3d3a33] bg-[#0e0d0b]">
      <div className="grid grid-cols-3 border-b border-[#1f1d19] px-6 py-3">
        {["Tier", "Min. price", "Score required"].map((h) => (
          <div
            key={h}
            className="text-[10px] uppercase tracking-[0.22em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {h}
          </div>
        ))}
      </div>
      {tiers.map((row, i) => (
        <div
          key={i}
          className={`grid grid-cols-3 border-b border-[#1f1d19] px-6 py-4 ${i === 2 ? "bg-[#100a0a]" : ""}`}
        >
          <div
            className={`text-[13px] ${i === 2 ? "text-[#c2410c]" : "text-[#f5f4ee]"}`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {row.tier}
          </div>
          <div
            className="text-[13px] text-[#b8b5a8]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {row.price}
          </div>
          <div
            className="text-[13px] text-[#8a8779]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {row.req}
          </div>
        </div>
      ))}
      <div className="px-6 py-3">
        <span
          className="border-b border-[#3d3a33] pb-0.5 text-[10px] text-[#5e5b51]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          How is this calculated? ↗
        </span>
      </div>
    </div>
  );
}

function CodeMockup() {
  return (
    <div className="border border-[#3d3a33] bg-[#0e0d0b]">
      <div className="flex items-center gap-2 border-b border-[#1f1d19] px-5 py-3">
        <span
          className="text-[10px] uppercase tracking-[0.2em] text-[#5e5b51]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          lending_pool.rs
        </span>
      </div>
      <pre
        className="overflow-x-auto p-6 text-[12px] leading-[1.75]"
        style={{ fontFamily: "var(--font-mono)" }}
      >{`fn accept_collateral(
    env: Env,
    contract: Address
) {
    `}<span className="text-[#c2410c]">require_signet_attestation</span>{`(
        &env, &contract,
        "non-pausable"
    );
    `}<span className="text-[#c2410c]">require_signet_score</span>{`(
        &env,
        &contract.deployer(),
        70
    );
    // …
}`}</pre>
    </div>
  );
}

const useCases = [
  {
    num: "01",
    title: "Grant programs",
    headline: "Faster, evidence-based review.",
    body: "Grant reviewers cite Signet profiles directly: verified deployment history, peer attestations, and incident records aggregated into a single citation. Reduces due diligence by hours per application.",
    mockup: <GrantMockup />,
    flip: false,
  },
  {
    num: "02",
    title: "Audit firms",
    headline: "Risk-weighted pricing.",
    body: "Audit firms tier engagement pricing by deployer track record. Verified Signet profiles unlock reduced rates and faster turnarounds for developers with established deployment history.",
    mockup: <AuditMockup />,
    flip: true,
  },
  {
    num: "03",
    title: "Protocol integration",
    headline: "Composable trust requirements.",
    body: "Smart contracts can require Signet attestations from counterparties at runtime. Lending pools refuse pausable collateral. Bridges accept only audited issuers. Reputation becomes a programmable input.",
    mockup: <CodeMockup />,
    flip: false,
  },
];

export function Unlocks() {
  return (
    <section className="relative px-4 py-28 md:px-14">
      {/* Section header */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        className="mb-20"
      >
        <SectionLabel>05 · Applications</SectionLabel>
        <h2
          className="mt-6 text-[48px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[64px]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Where Signet is used.
        </h2>
        <p className="mt-5 max-w-[480px] text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>
          Verified deployment history, applied to three real workflows.
        </p>
      </motion.div>

      {/* Stripes */}
      <div className="flex flex-col gap-0">
        {useCases.map((uc, i) => (
          <motion.div
            key={i}
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.15 }}
            className={`grid grid-cols-1 gap-10 border-t border-[#1f1d19] py-16 md:grid-cols-2 md:gap-16 md:items-center ${
              uc.flip ? "md:[&>*:first-child]:order-2" : ""
            }`}
          >
            {/* Copy */}
            <div>
              <div
                className="mb-3 text-[10px] uppercase tracking-[0.26em] text-[#8b1a1a]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {uc.num} · {uc.title}
              </div>
              <h3
                className="text-[28px] font-bold leading-[1.05] tracking-[-0.02em] text-[#f5f4ee] md:text-[34px]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {uc.headline}
              </h3>
              <p className="mt-5 text-[15px] leading-[1.65] tracking-[-0.005em] text-[#8a8779]" style={{ fontFamily: "var(--font-body)" }}>{uc.body}</p>
            </div>

            {/* Mockup */}
            <div>{uc.mockup}</div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
