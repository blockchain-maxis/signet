import Link from "next/link";

export default function HandleNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      {/* Seal mark */}
      <div className="mb-10 opacity-60">
        <svg
          width="80"
          height="80"
          viewBox="0 0 80 80"
          fill="none"
          aria-hidden="true"
        >
          {/* Outer tick ring */}
          {Array.from({ length: 24 }, (_, i) => {
            const angle = (i / 24) * 360;
            const rad = (angle * Math.PI) / 180;
            const isMajor = i % 6 === 0;
            const r1 = 36;
            const r2 = isMajor ? 30 : 33;
            return (
              <line
                key={i}
                x1={40 + r1 * Math.cos(rad)}
                y1={40 + r1 * Math.sin(rad)}
                x2={40 + r2 * Math.cos(rad)}
                y2={40 + r2 * Math.sin(rad)}
                stroke="#8b1a1a"
                strokeWidth={isMajor ? 1.5 : 0.75}
                strokeLinecap="round"
              />
            );
          })}

          {/* Outer ring */}
          <circle
            cx="40"
            cy="40"
            r="38"
            stroke="#5e5b51"
            strokeWidth="0.75"
            fill="none"
          />
          {/* Inner ring */}
          <circle
            cx="40"
            cy="40"
            r="28"
            stroke="#3d3a33"
            strokeWidth="0.5"
            fill="none"
          />

          {/* Crosshair guides */}
          <line x1="40" y1="14" x2="40" y2="22" stroke="#5e5b51" strokeWidth="0.5" />
          <line x1="40" y1="58" x2="40" y2="66" stroke="#5e5b51" strokeWidth="0.5" />
          <line x1="14" y1="40" x2="22" y2="40" stroke="#5e5b51" strokeWidth="0.5" />
          <line x1="58" y1="40" x2="66" y2="40" stroke="#5e5b51" strokeWidth="0.5" />

          {/* Hex + S sigil */}
          <polygon
            points="40,22 52,29 52,43 40,50 28,43 28,29"
            stroke="#8b8779"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M36,34 C36,32 44,32 44,36 C44,40 36,40 36,44 C36,48 44,48 44,46"
            stroke="#f5f4ee"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>

      <p
        className="mb-2 text-xs font-mono uppercase tracking-[0.2em]"
        style={{ color: "#8b1a1a" }}
      >
        Handle not found
      </p>

      <h1
        className="mb-6 text-4xl font-bold leading-tight tracking-[-0.025em]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Profile not found.
      </h1>

      <p className="mb-10 max-w-xs text-sm leading-relaxed" style={{ color: "#8a8779" }}>
        This handle hasn&apos;t been claimed yet. Signet profiles are minted
        on&#8209;chain during the public launch.
      </p>

      <div className="flex flex-col items-center gap-4">
        <Link
          href="/reserve"
          className="inline-flex items-center gap-2 border px-6 py-3 text-sm font-mono uppercase tracking-widest transition-colors hover:bg-[#8b1a1a] hover:border-[#8b1a1a]"
          style={{ borderColor: "#8b1a1a", color: "#f5f4ee" }}
        >
          Available · Reserve this handle →
        </Link>
        <Link
          href="/"
          className="text-xs font-mono uppercase tracking-widest"
          style={{ color: "#5e5b51" }}
        >
          ← Back to Signet
        </Link>
      </div>
    </main>
  );
}
