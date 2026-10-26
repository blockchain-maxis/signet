/**
 * The portal's one page: the form, and below it what Signet said.
 *
 * Plain server-rendered HTML with every value escaped, no client script. The
 * palette is Signet's (off-black, off-white, one coral accent), light or dark
 * by the reader's system setting.
 */
import type { Contract, Verification, Wallet } from './verify.ts';

export interface PageInput {
  /** Public base URL of the Signet deployment, for the badge and profile links. */
  signetUrl: string;
  handle: string;
  address: string;
  /** Absent before the form is submitted. */
  result?: Verification;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f7f6f2; --surface: #ffffff; --ink: #1b1a17; --muted: #5d5a52;
  --line: #d9d6cc; --accent: #b3392c; --accent-fill: #e05a4b; --on-accent: #0a0908;
  --warn-bg: #fbf1e6; --warn-line: #e3c9a8;
  --font: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --mono: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0908; --surface: #151411; --ink: #f2efe8; --muted: #a3a092;
    --line: #2e2c27; --accent: #ef7c6f; --warn-bg: #241d14; --warn-line: #4a3b26;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--font); }
main { max-width: 760px; margin: 0 auto; padding: 48px 16px 64px; }
h1 { font-size: 1.75rem; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 8px; }
h2 { font-size: 1.125rem; margin: 0 0 12px; }
h3 { font-size: 1rem; margin: 28px 0 8px; }
p { margin: 0 0 12px; max-width: 65ch; }
.lede { color: var(--muted); }
form { display: grid; grid-template-columns: 1fr 1.6fr auto; gap: 12px; align-items: end; margin: 28px 0 36px; }
@media (max-width: 640px) { form { grid-template-columns: 1fr; } }
label { display: grid; gap: 6px; font-size: 0.875rem; font-weight: 600; }
input { font: 15px var(--mono); padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); min-width: 0; }
input::placeholder { color: var(--muted); opacity: 1; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { font: 600 15px var(--font); padding: 11px 18px; border: 0; border-radius: 8px; background: var(--accent-fill); color: var(--on-accent); cursor: pointer; white-space: nowrap; }
button:active { transform: translateY(1px); }
.result { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 20px; }
.result.warn { background: var(--warn-bg); border-color: var(--warn-line); }
.verdict { display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.verdict h2 { margin: 0; }
.verdict img { display: block; height: 20px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 16px 0 0; font-size: 0.9375rem; }
dt { color: var(--muted); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
code { font: 0.875em var(--mono); overflow-wrap: anywhere; }
ul { list-style: none; padding: 0; margin: 0; }
li { padding: 8px 0; border-top: 1px solid var(--line); display: flex; gap: 12px; justify-content: space-between; align-items: baseline; flex-wrap: wrap; font-size: 0.9375rem; }
li .meta { color: var(--muted); }
li.match { font-weight: 600; }
a { color: var(--accent); }
.note { color: var(--muted); font-size: 0.875rem; margin-top: 12px; }
`;

function walletList(wallets: Wallet[], deployer?: string): string {
  if (!wallets.length) return '<p class="note">Signet lists no wallets for this handle.</p>';
  return `<ul>${wallets
    .map(
      (w) =>
        `<li${w.address === deployer ? ' class="match"' : ''}><code>${e(w.address)}</code><span class="meta">${e(
          [w.isPrimary ? 'primary' : null, `linked ${w.source}`].filter(Boolean).join(', '),
        )}</span></li>`,
    )
    .join('')}</ul>`;
}

function contractList(contracts: Contract[], truncated: boolean, address: string): string {
  if (!contracts.length) {
    return `<p class="note">${
      truncated
        ? 'Signet could not list this handle’s contracts right now.'
        : 'Signet has no contracts deployed by this handle’s wallets.'
    }</p>`;
  }
  const rows = contracts
    .map(
      (c) =>
        `<li${c.address === address ? ' class="match"' : ''}><code>${e(short(c.address))}</code><span class="meta">${e(
          c.deployedAt.slice(0, 10),
        )}</span></li>`,
    )
    .join('');
  const more = truncated ? '<p class="note">More contracts exist than are listed here.</p>' : '';
  return `<ul>${rows}</ul>${more}`;
}

function resultBlock(input: PageInput, result: Verification): string {
  const base = input.signetUrl.replace(/\/$/, '');
  const handle = input.handle.trim().toLowerCase();
  const profileUrl = `${base}/p/${encodeURIComponent(handle)}`;
  const badge = `${base}/api/v1/badge/${encodeURIComponent(handle)}.svg?contract=${encodeURIComponent(input.address)}`;

  switch (result.kind) {
    case 'verified':
    case 'not-attributed': {
      const verified = result.kind === 'verified';
      const deployer = verified ? result.attribution.wallet : undefined;
      return `<section class="result" aria-live="polite">
<div class="verdict"><h2>${
        verified
          ? `Verified: @${e(handle)} deployed this contract`
          : `Not verified: @${e(handle)} did not deploy this contract`
      }</h2><a href="${e(profileUrl)}"><img src="${e(badge)}" alt="Signet badge for @${e(handle)}"></a></div>
<dl>
<dt>Contract</dt><dd><code>${e(input.address)}</code></dd>
${
  verified
    ? `<dt>Deployed by</dt><dd><code>${e(result.attribution.wallet)}</code></dd>
<dt>Checked by</dt><dd>${
        result.attribution.method === 'indexer'
          ? 'Signet’s index of deployments'
          : 'a check of the wallet’s deploy history on Horizon'
      }</dd>`
    : `<dt>Meaning</dt><dd>None of this handle’s wallets deployed it, as far as Signet knows. A contract created through a factory contract is not attributed.</dd>`
}
<dt>Network</dt><dd>${e(result.profile.network)}</dd>
</dl>
<h3>Wallets</h3>${walletList(result.wallets, deployer)}
<h3>Contracts</h3>${contractList(result.contracts, result.contractsTruncated, input.address)}
<p class="note"><a href="${e(profileUrl)}">Full profile on Signet</a></p>
</section>`;
    }
    case 'no-profile':
      return `<section class="result warn" aria-live="polite"><h2>No Signet profile for @${e(handle)}</h2>
<p>Ask the applicant for the handle they claimed on Signet, or to claim one and link the wallet they deploy from.</p></section>`;
    case 'invalid':
      return `<section class="result warn" aria-live="polite"><h2>Check the ${
        result.parameter === 'address'
          ? 'contract address'
          : result.parameter === 'handle'
            ? 'handle'
            : 'form'
      }</h2><p>${e(result.message)}</p><p class="note">A handle is lowercase letters, digits, <code>-</code> and <code>_</code>. A contract address starts with <code>C</code> and is 56 characters.</p></section>`;
    case 'rate-limited':
      return `<section class="result warn" aria-live="polite"><h2>Signet is limiting requests from this portal</h2>
<p>${
        result.retryAfterSeconds !== null
          ? `Try again in ${result.retryAfterSeconds} seconds.`
          : 'Try again shortly.'
      } An API key (<code>SIGNET_API_KEY</code>) raises the limit.</p></section>`;
    case 'unavailable':
      return `<section class="result warn" aria-live="polite"><h2>Signet could not check this right now</h2>
<p>This is not a verdict: the deployment could not reach the data it checks against. Try again in a minute.</p><p class="note">${e(result.message)}</p></section>`;
    case 'network':
      return `<section class="result warn" aria-live="polite"><h2>The portal could not reach Signet</h2>
<p>Check <code>SIGNET_URL</code> and that the deployment is up.</p><p class="note">${e(result.message)}</p></section>`;
  }
}

export function renderPage(input: PageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify an applicant</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Verify an applicant</h1>
<p class="lede">Check that a grant applicant’s Signet handle deployed the contract they say they built.</p>
<form method="get" action="/verify">
<label>Signet handle<input name="handle" value="${e(input.handle)}" required autocomplete="off" spellcheck="false" placeholder="alice"></label>
<label>Contract address<input name="address" value="${e(input.address)}" required autocomplete="off" spellcheck="false" placeholder="C…"></label>
<button type="submit">Verify</button>
</form>
${input.result ? resultBlock(input, input.result) : ''}
</main>
</body>
</html>
`;
}
