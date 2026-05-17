import { notFound } from "next/navigation";
import { prisma } from "@signet/db";
import { SignetMonogram } from "../../../(marketing)/components/signet-monogram";

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(str: string, head: number, tail: number): string {
  if (str.length <= head + tail + 3) return str;
  return `${str.slice(0, head)}...${str.slice(-tail)}`;
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function fmtDateLong(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function relativeTime(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} days ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}yr ago`;
}

function stellarExpertUrl(
  type: "contract" | "account" | "tx",
  id: string,
  network = "mainnet",
): string {
  return `https://stellar.expert/explorer/${network}/contract/${id}`.replace(
    `/contract/${id}`,
    `/${type}/${id}`,
  );
}

// ─── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 text-[10px] uppercase tracking-[0.26em] text-[#8a8779]"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" aria-hidden="true" />
      {children}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return {
    title: `${handle} · Signet`,
    description: `Verified Soroban deployments and on-chain career record for ${handle}.`,
  };
}

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  const profile = await prisma.profile.findUnique({
    where: { handle: handle.toLowerCase() },
    include: {
      wallets: {
        include: {
          contracts: {
            orderBy: { deployedAt: "desc" },
            include: {
              snapshots: {
                orderBy: { capturedAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
    },
  });

  if (!profile) notFound();

  const allContracts = profile.wallets.flatMap((w) => w.contracts);
  const totalTxCount = allContracts.reduce(
    (sum, c) => sum + (c.snapshots[0]?.txCountTotal ?? 0),
    0,
  );
  const sortedByDate = [...allContracts].sort(
    (a, b) => a.deployedAt.getTime() - b.deployedAt.getTime(),
  );
  const firstDeployment = sortedByDate[0]?.deployedAt ?? null;
  const lastActivities = allContracts
    .flatMap((c) => (c.snapshots[0]?.lastActivity ? [c.snapshots[0].lastActivity] : []))
    .sort((a, b) => b.getTime() - a.getTime());
  const mostRecentActivity = lastActivities[0] ?? null;

  const cursor = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
  const network = allContracts[0]?.network ?? "mainnet";
  const hasWallets = profile.wallets.length > 0;
  const hasContracts = allContracts.length > 0;

  return (
    <div className="relative">
      {/* Grain */}
      <div
        className="pointer-events-none fixed inset-0 z-30 opacity-[0.07] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
        aria-hidden="true"
      />

      {/* Nav */}
      <nav className="relative z-40 flex items-center justify-between border-b border-[#1f1d19] px-8 py-6 md:px-14">
        <a href="/" className="flex items-center gap-3">
          <SignetMonogram className="h-5 w-5 text-[#f5f4ee]" />
          <span className="text-[14px] font-medium tracking-tight">Signet</span>
        </a>
        <div
          className="hidden gap-8 text-[11px] uppercase tracking-[0.22em] text-[#8a8779] md:flex"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <a href="/" className="transition-colors hover:text-[#f5f4ee]">
            Home
          </a>
          <a href="/docs" className="transition-colors hover:text-[#f5f4ee]">
            Docs
          </a>
        </div>
        <a
          href="/#claim"
          className="text-[11px] uppercase tracking-[0.22em] text-[#f5f4ee]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="border-b border-[#8b1a1a] pb-1">Claim yours</span>
          <span className="ml-1.5 text-[#8b1a1a]">→</span>
        </a>
      </nav>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="relative z-10 border-b border-[#1f1d19] px-8 py-16 md:px-14 md:py-20">
        <div className="max-w-5xl">
          <div
            className="text-[11px] uppercase tracking-[0.26em] text-[#5e5b51]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Profile · Active since {fmtDate(profile.createdAt)}
          </div>

          <h1
            className="mt-5 text-[56px] font-bold leading-[0.96] tracking-[-0.025em] text-[#f5f4ee] md:text-[88px]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {profile.displayName
              ? profile.displayName
              : <em className="not-italic">@{profile.handle}</em>}
          </h1>

          {profile.displayName && (
            <div
              className="mt-3 text-[14px] uppercase tracking-[0.18em] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              @{profile.handle}
            </div>
          )}

          {profile.bio && (
            <p className="mt-5 max-w-[560px] text-[16px] leading-[1.6] text-[#8a8779]">
              {profile.bio}
            </p>
          )}

          <div className="mt-7 flex items-center gap-3">
            <span
              className="h-1.5 w-1.5 rounded-full bg-[#8b1a1a]"
              aria-hidden="true"
            />
            <span
              className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Phase 1 · Curated bindings
            </span>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-5xl space-y-0 px-8 py-16 md:px-14">

        {/* ── Linked wallets ──────────────────────────────────────────────── */}
        <section aria-labelledby="wallets-heading" className="pb-16">
          <SectionLabel>Linked wallets</SectionLabel>

          {!hasWallets ? (
            <p
              className="mt-6 text-[14px] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Wallets pending. Check back shortly.
            </p>
          ) : (
            <div className="mt-6 border border-[#1f1d19]">
              {profile.wallets.map((wallet, i) => (
                <div
                  key={wallet.id}
                  className={`flex flex-wrap items-center justify-between gap-4 px-5 py-4 ${
                    i < profile.wallets.length - 1 ? "border-b border-[#1f1d19]" : ""
                  }`}
                >
                  <div className="flex items-center gap-5">
                    <span
                      className="text-[13px] text-[#b8b5a8]"
                      style={{ fontFamily: "var(--font-mono)" }}
                      title={wallet.pubkey}
                    >
                      {truncate(wallet.pubkey, 6, 4)}
                    </span>
                    <span
                      className="border border-[#3d3a33] px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-[#5e5b51]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {wallet.source}
                    </span>
                  </div>
                  <div className="flex items-center gap-5">
                    <span
                      className="text-[10px] text-[#5e5b51]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {fmtDateLong(wallet.attestedAt)}
                    </span>
                    <a
                      href={stellarExpertUrl("account", wallet.pubkey, network)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] uppercase tracking-[0.2em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      Stellar Expert ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Stats row ───────────────────────────────────────────────────── */}
        {hasWallets && (
          <section aria-labelledby="stats-heading" className="pb-16">
            <SectionLabel>Overview</SectionLabel>
            <div className="mt-6 grid grid-cols-2 gap-px border border-[#1f1d19] bg-[#1f1d19] md:grid-cols-4">
              {[
                {
                  label: "Contracts deployed",
                  value: String(allContracts.length),
                },
                {
                  label: "Total invocations",
                  value: fmtNumber(totalTxCount),
                },
                {
                  label: "First deployment",
                  value: firstDeployment ? fmtDate(firstDeployment) : "—",
                },
                {
                  label: "Most recent activity",
                  value: mostRecentActivity ? relativeTime(mostRecentActivity) : "—",
                },
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className="flex flex-col justify-center bg-[#0a0908] px-6 py-6"
                >
                  <span
                    className="text-[32px] font-bold leading-none tracking-[-0.025em] text-[#f5f4ee]"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {value}
                  </span>
                  <span
                    className="mt-2 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Contracts ───────────────────────────────────────────────────── */}
        {hasWallets && (
          <section aria-labelledby="contracts-heading" className="pb-16">
            <SectionLabel>
              Deployed contracts
              {hasContracts && (
                <span className="ml-1 text-[#5e5b51]">· {allContracts.length}</span>
              )}
            </SectionLabel>

            {!hasContracts ? (
              <div className="mt-6 border border-[#1f1d19] px-5 py-6">
                <p
                  className="text-[13px] text-[#5e5b51]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Indexing in progress. Contracts will appear as they are aggregated from
                  Stellar.
                </p>
                {/* Placeholder skeleton */}
                <div className="mt-4 space-y-3">
                  {[1, 2, 3].map((n) => (
                    <div
                      key={n}
                      className="h-10 animate-pulse bg-[#1f1d19] opacity-40"
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-6 border border-[#1f1d19]">
                {/* Header row */}
                <div
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-[#1f1d19] px-5 py-3 text-[9px] uppercase tracking-[0.22em] text-[#5e5b51]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  <span>Address</span>
                  <span className="hidden md:block">Deployed</span>
                  <span className="hidden md:block">Invocations</span>
                  <span>Verify</span>
                </div>

                {allContracts.map((contract, i) => {
                  const snapshot = contract.snapshots[0];
                  return (
                    <div
                      key={contract.id}
                      className={`group grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-4 transition-colors hover:bg-[#0e0d0b] ${
                        i < allContracts.length - 1 ? "border-b border-[#1f1d19]" : ""
                      }`}
                    >
                      <span
                        className="text-[13px] text-[#b8b5a8]"
                        style={{ fontFamily: "var(--font-mono)" }}
                        title={contract.address}
                      >
                        {truncate(contract.address, 5, 4)}
                      </span>
                      <span
                        className="hidden text-[11px] text-[#5e5b51] md:block"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {fmtDateLong(contract.deployedAt)}
                      </span>
                      <span
                        className="hidden text-[11px] text-[#5e5b51] md:block"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {snapshot ? fmtNumber(snapshot.txCountTotal) : "—"}
                      </span>
                      <a
                        href={stellarExpertUrl("contract", contract.address, contract.network)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="whitespace-nowrap text-[10px] uppercase tracking-[0.18em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        Verify ↗
                      </a>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* ── Trust footer ────────────────────────────────────────────────── */}
        <section className="pb-10">
          <SectionLabel>Verification</SectionLabel>
          <div className="mt-6 border border-[#1f1d19] px-6 py-6">
            <p className="max-w-[680px] text-[13px] leading-[1.7] text-[#5e5b51]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Every contract on this profile is real and independently verifiable on Stellar
              Expert. Profile-to-wallet bindings are currently curated by Signet; cryptographic
              self-attestation via the on-chain Identity Registry lands in Phase 2.
            </p>
            <a
              href="/#manifesto"
              className="mt-4 inline-block text-[10px] uppercase tracking-[0.22em] text-[#8b1a1a] transition-colors hover:text-[#c2410c]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              Read the manifesto ↗
            </a>
          </div>
        </section>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────────── */}
      <footer className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f1d19] px-8 py-4 md:px-14">
        <div
          className="flex items-center gap-7 text-[10px] uppercase tracking-[0.22em] text-[#8a8779]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="flex items-center gap-2.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#8b1a1a] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" />
            </span>
            {network} · live
          </span>
          {cursor && cursor.lastLedger > 0 && (
            <span className="hidden md:inline">
              Ledger&nbsp;{fmtNumber(cursor.lastLedger)}
            </span>
          )}
        </div>
        <div
          className="text-[10px] uppercase tracking-[0.22em] text-[#3d3a33]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Stellar Community Fund · 2026
        </div>
      </footer>
    </div>
  );
}
