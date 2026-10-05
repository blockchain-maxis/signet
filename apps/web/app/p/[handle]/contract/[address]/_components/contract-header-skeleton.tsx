const MONO = { fontFamily: 'var(--font-mono)' } as const;

// Same grid, padding and line height as the rows in `contract-header.tsx`, with
// the same labels, so the real header replaces this without moving the tabs
// below it. A row's value is one bar per line it normally takes: the WASM hash
// and the deployer each carry a second line.
function Row({ label, lines = 1 }: { label: string; lines?: number }) {
  return (
    <div className="grid gap-x-8 gap-y-1 py-3 sm:grid-cols-[9rem_1fr]">
      <dt className="text-[10px] uppercase tracking-[0.22em] text-[#8a8779]">{label}</dt>
      <dd className="min-w-0" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className={`block h-[22px] max-w-xl bg-[#1f1d19] motion-safe:animate-pulse ${i === 0 ? 'w-full' : 'mt-1 w-2/3'}`}
          />
        ))}
      </dd>
    </div>
  );
}

/**
 * Stand-in for the contract header while its live WASM read is in flight
 * (#459). The read is the one slow thing the layout waits on after attribution,
 * so the layout streams the rest of the frame and shows this in its place.
 */
export function ContractHeaderSkeleton() {
  return (
    <section aria-label="Contract details" aria-busy="true" data-testid="contract-header-skeleton">
      <span role="status" className="sr-only">
        Loading contract details
      </span>
      <dl className="divide-y divide-[#1f1d19] border-y border-[#1f1d19]" style={MONO}>
        <Row label="Address" />
        <Row label="Network" />
        <Row label="WASM hash" lines={2} />
        <Row label="Deploy tx" />
        <Row label="Deployed" />
        <Row label="Deployer" lines={2} />
      </dl>
    </section>
  );
}
