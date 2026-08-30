import { isDatabaseConfigured } from '../../lib/profiles.ts';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Link the CLI · Signet',
  description: 'Approve a terminal pairing request for your Signet account.',
};

/**
 * `/link` — the approval page a `signet link` pairing sends the developer to.
 *
 * The approval UI itself belongs to the pairing work (#258/#268). What this
 * page owns today is the precondition: **if linking cannot be persisted, say
 * so before the developer approves.**
 *
 * Checked server-side, on the same signal the API route enforces, so the two
 * cannot disagree. Approving a link that will be refused seconds later is the
 * worst version of this: the developer has signed something, believes they are
 * linked, and finds out otherwise from an unrelated command.
 */
export default function LinkPage() {
  const linkingAvailable = isDatabaseConfigured();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Link the Signet CLI</h1>

      {linkingAvailable ? (
        <p className="text-sm opacity-80">
          Approve the pairing request shown in your terminal. The approval flow itself lands with
          the CLI pairing work.
        </p>
      ) : (
        <section
          role="alert"
          aria-labelledby="linking-unavailable-title"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-5"
        >
          <h2 id="linking-unavailable-title" className="text-base font-semibold">
            Linking is unavailable on this deployment
          </h2>
          <p className="mt-2 text-sm opacity-90">
            Wallet links are stored in a database, and this deployment has no{' '}
            <code>DATABASE_URL</code> configured. Approving now would appear to succeed and save
            nothing, so approval is disabled.
          </p>
          <p className="mt-2 text-sm opacity-90">
            {/* Whose problem this is, stated plainly. Nothing the developer
                does to their own account will change it. */}
            This is a configuration problem with the Signet deployment, not with your account.
            Whoever operates this deployment needs to provision a database — see{' '}
            <a className="underline" href="https://github.com/blockchain-maxis/signet/issues/191">
              issue #191
            </a>{' '}
            and{' '}
            <a
              className="underline"
              href="https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md#linking-requires-a-database"
            >
              docs/CLI.md
            </a>
            .
          </p>
        </section>
      )}
    </main>
  );
}
