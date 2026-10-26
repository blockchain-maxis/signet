/**
 * `GET /api/v1/badge/{handle}.svg` (#656): a "Verified by Signet" badge for a
 * README or portfolio, linking a reader back to the profile.
 *
 * It says only what this deployment can attest to, on its own network:
 *
 * - `verified`: the handle is bound, with how many contracts its wallets
 *   deployed (`N+` when the count is a lower bound). With `?contract=C…`,
 *   only when that contract's attribution check (#632) passes.
 * - `not-verified`: the handle is bound, but `?contract=` names a contract it
 *   did not deploy (or not a contract at all).
 * - `not-found`: no such handle.
 * - `unavailable`: Signet could not check. Grey, never a verdict.
 *
 * Always a 200 `image/svg+xml`, so an `<img>` never breaks, with the state in
 * `X-Signet-Badge-State`. The SVG is self-contained (no fonts or images
 * fetched), every string in it is escaped, and the network has its own
 * segment, striped on a test network, so a testnet badge cannot pass for a
 * mainnet one.
 */
import { createHash } from 'node:crypto';
import { isValidHandle, type Network } from '@signet/types';
import { STELLAR_NETWORK } from '../../chain.ts';
import { attributeContract, type Attribution } from '../../contract-attribution.ts';
import { getProfileContracts, type ProfileContractsResult } from '../../profile-contracts.ts';
import { getProfile, type Profile } from '../../profiles.ts';
import { rateLimit } from '../../rate-limit.ts';
import { LIMITS, WINDOW_MS } from '../../rate-limit-policy.ts';
import { clientIp } from '../../security.ts';
import { resolveHandleDetailed, type HandleResolution } from '../../server/registry-read.ts';
import { matchIfNoneMatch } from './http.ts';

export type BadgeState = 'verified' | 'not-verified' | 'not-found' | 'unavailable';
export type BadgeStyle = 'flat' | 'plain';

export const BADGE_CACHE_CONTROL = 'public, max-age=300';

export interface BadgeContent {
  state: BadgeState;
  /** The right-hand text, e.g. `@alice · 3 contracts`. */
  message: string;
  network: Network;
  /** The accessible name: what the badge says, in a sentence. */
  title: string;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Off-black page, raised surface, off-white ink, and the site's one accent. */
const INK = '#0a0908';
const RAISED = '#1f1d19';
const PAPER = '#f2efe8';
const ACCENT = '#e05a4b';

/**
 * Each state's message segment. Every pair clears WCAG AA (4.5:1) for 11px
 * text: ink on the accent is 6.0:1, paper on the greys 11.9:1 and 6.6:1.
 */
const MESSAGE_COLORS: Record<BadgeState, { fill: string; text: string }> = {
  verified: { fill: ACCENT, text: INK },
  'not-verified': { fill: '#3a3731', text: PAPER },
  'not-found': { fill: '#3a3731', text: PAPER },
  unavailable: { fill: '#5c5952', text: PAPER },
};

const FONT = 'Verdana,DejaVu Sans,Geneva,sans-serif';
const FONT_SIZE = 11;
const PAD = 7;
const HEIGHT = 20;

/**
 * Approximate advance widths for Verdana at 11px, so the segments fit their
 * text without measuring a font the badge never loads. Generous by a pixel:
 * a wider renderer than Verdana must not clip.
 */
function textWidth(text: string, bold = false): number {
  let w = 0;
  for (const ch of text) {
    if ("iljI.,:;!|'·".includes(ch)) w += 3.6;
    else if ('frt()[]'.includes(ch)) w += 4.6;
    else if (ch === ' ') w += 3.9;
    else if ('mwMW@'.includes(ch)) w += 10.4;
    else if (/[A-Z]/.test(ch)) w += 7.6;
    else if (/[0-9]/.test(ch)) w += 7;
    else w += 6.7;
  }
  return Math.ceil(w * (bold ? 1.08 : 1)) + 1;
}

/** Escapes text for SVG content and attribute values. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const isTestNetwork = (network: Network) => network !== 'mainnet';

/** The badge as a self-contained SVG document. */
export function renderBadge(content: BadgeContent, style: BadgeStyle = 'flat'): string {
  const label = 'Signet';
  const net = content.network.toUpperCase();
  const segments = [
    { text: label, bold: true },
    { text: content.message, bold: false },
    { text: net, bold: true },
  ].map((s) => ({ ...s, width: textWidth(s.text, s.bold) + PAD * 2 }));
  const total = segments.reduce((n, s) => n + s.width, 0);
  let x = 0;
  const placed = segments.map((s) => {
    const at = x;
    x += s.width;
    return { ...s, x: at };
  });
  const [lab, msg, nw] = placed as [(typeof placed)[0], (typeof placed)[0], (typeof placed)[0]];
  const title = escapeXml(content.title);
  const textAt = (s: (typeof placed)[0], fill: string) =>
    `<text x="${s.x + s.width / 2}" y="14" fill="${fill}" text-anchor="middle"${
      s.bold ? ' font-weight="bold"' : ''
    }>${escapeXml(s.text)}</text>`;

  const stripes = isTestNetwork(content.network);
  // Ids unique to this badge, so two badges inlined in one page do not share
  // a clip path or pattern.
  const id = createHash('sha1')
    .update(`${style}|${content.state}|${content.message}|${content.network}`)
    .digest('hex')
    .slice(0, 8);
  const defs = [
    `<clipPath id="r${id}"><rect width="${total}" height="${HEIGHT}" rx="3"/></clipPath>`,
    stripes
      ? `<pattern id="t${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${PAPER}"/><rect width="2.5" height="6" fill="#d9d4c8"/></pattern>`
      : '',
  ].join('');

  let body: string;
  if (style === 'plain') {
    // One colour family, for pages where colour is noise: the state is in
    // the words; the network keeps its stripes.
    body = [
      `<rect width="${total}" height="${HEIGHT}" fill="${PAPER}"/>`,
      stripes
        ? `<rect x="${nw.x}" width="${nw.width}" height="${HEIGHT}" fill="url(#t${id})"/>`
        : '',
      `<path d="M${msg.x}.5 0v${HEIGHT}M${nw.x}.5 0v${HEIGHT}" stroke="#8a8779"/>`,
      `<rect x=".5" y=".5" width="${total - 1}" height="${HEIGHT - 1}" rx="2.5" fill="none" stroke="#8a8779"/>`,
      `<g font-family="${FONT}" font-size="${FONT_SIZE}">`,
      textAt(lab, INK),
      textAt(msg, INK),
      textAt(nw, INK),
      '</g>',
    ].join('');
  } else {
    const colors = MESSAGE_COLORS[content.state];
    body = [
      `<g clip-path="url(#r${id})">`,
      `<rect width="${lab.width}" height="${HEIGHT}" fill="${RAISED}"/>`,
      `<rect x="${msg.x}" width="${msg.width}" height="${HEIGHT}" fill="${colors.fill}"/>`,
      `<rect x="${nw.x}" width="${nw.width}" height="${HEIGHT}" fill="${stripes ? `url(#t${id})` : PAPER}"/>`,
      '</g>',
      `<g font-family="${FONT}" font-size="${FONT_SIZE}">`,
      textAt(lab, PAPER),
      textAt(msg, colors.text),
      textAt(nw, INK),
      '</g>',
    ].join('');
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" role="img" aria-label="${title}">` +
    `<title>${title}</title><defs>${defs}</defs>${body}</svg>\n`
  );
}

// ── State ───────────────────────────────────────────────────────────────────

export interface BadgeDeps {
  network?: Network;
  getProfile?: (handle: string) => Promise<Profile | null>;
  resolveHandle?: (handle: string) => Promise<HandleResolution>;
  getProfileContracts?: (handle: string) => Promise<ProfileContractsResult>;
  attribute?: (handle: string, address: string) => Promise<Attribution>;
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** What the badge for this handle (and optional contract) says. */
export async function getBadgeContent(
  rawHandle: string,
  options: { contract?: string | null } = {},
  deps: BadgeDeps = {},
): Promise<BadgeContent> {
  const network = deps.network ?? STELLAR_NETWORK;
  const unavailable: BadgeContent = {
    state: 'unavailable',
    message: 'status unavailable',
    network,
    title: `Signet: status unavailable on ${network}`,
  };
  const handle = rawHandle.trim().toLowerCase();
  // A malformed handle is nobody's: the badge never echoes it.
  if (!isValidHandle(handle)) {
    return {
      state: 'not-found',
      message: 'not on Signet',
      network,
      title: `Signet: not on Signet (${network})`,
    };
  }
  const notFound: BadgeContent = {
    state: 'not-found',
    message: 'not on Signet',
    network,
    title: `Signet: @${handle} is not on Signet (${network})`,
  };

  let profile: Profile | null;
  try {
    profile = await (deps.getProfile ?? getProfile)(handle);
  } catch {
    return unavailable;
  }
  if (!profile) {
    // No layer knows it: only a registry that answered "unbound" makes that
    // a "not on Signet"; one that could not be read is no verdict.
    const resolved = await (deps.resolveHandle ?? resolveHandleDetailed)(handle).catch(
      (): HandleResolution => ({ status: 'error' }),
    );
    return resolved.status === 'unbound' ? notFound : unavailable;
  }
  // An archived binding's wallet cannot be read: Signet cannot attest it now.
  if (profile.archived) return unavailable;

  if (options.contract != null) {
    const verdict = await (deps.attribute ?? attributeContract)(handle, options.contract).catch(
      (): Attribution => ({ status: 'unavailable' }),
    );
    if (verdict.status === 'unavailable') return unavailable;
    if (verdict.status !== 'attributed') {
      return {
        state: 'not-verified',
        message: `@${handle} · contract not verified`,
        network,
        title: `Signet: @${handle} is on Signet, but this contract is not verified as theirs (${network})`,
      };
    }
    return {
      state: 'verified',
      message: `@${handle} · deployed ${short(verdict.contract.address)}`,
      network,
      title: `Signet: @${handle} deployed ${verdict.contract.address} on ${network}`,
    };
  }

  const listed = await (deps.getProfileContracts ?? getProfileContracts)(handle).catch(
    (): ProfileContractsResult | null => null,
  );
  let message = `@${handle}`;
  let counted = '';
  if (listed && listed.source !== 'none') {
    const n = listed.contracts.length;
    const count = `${n}${listed.truncated ? '+' : ''} ${n === 1 && !listed.truncated ? 'contract' : 'contracts'}`;
    message += ` · ${count}`;
    counted = `, ${count}`;
  }
  return {
    state: 'verified',
    message,
    network,
    title: `Signet: @${handle} is verified on ${network}${counted}`,
  };
}

// ── Route ───────────────────────────────────────────────────────────────────

/** `alice.svg` → `alice`; anything else → null. */
export function handleFromFile(file: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(file);
    } catch {
      return file;
    }
  })();
  return decoded.toLowerCase().endsWith('.svg') ? decoded.slice(0, -4) : null;
}

export interface BadgeHandlerDeps extends BadgeDeps {
  rateLimit?: (key: string) => Promise<{ ok: boolean }>;
}

type Ctx = { params: Promise<{ file: string }> };

/** The route's handler. Every answer is a 200 badge, or a 304. */
export function badgeHandler(deps: BadgeHandlerDeps = {}) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const url = new URL(req.url);
    const style: BadgeStyle = url.searchParams.get('style') === 'plain' ? 'plain' : 'flat';
    const network = deps.network ?? STELLAR_NETWORK;
    const limit = deps.rateLimit ?? ((key: string) => rateLimit(key, LIMITS.v1Read, WINDOW_MS));

    let content: BadgeContent;
    let cache = BADGE_CACHE_CONTROL;
    const allowed = await limit(`v1:badge:${clientIp(req.headers)}`).catch(() => ({ ok: true }));
    const handle = handleFromFile((await ctx.params).file);
    if (!allowed.ok) {
      // Over the limit is still an image: grey, and not cached.
      content = {
        state: 'unavailable',
        message: 'status unavailable',
        network,
        title: `Signet: status unavailable on ${network}`,
      };
      cache = 'no-store';
    } else {
      content = await getBadgeContent(
        handle ?? '',
        { contract: url.searchParams.get('contract') },
        deps,
      );
      if (content.state === 'unavailable') cache = 'no-store';
    }

    const svg = renderBadge(content, style);
    const etag = `W/"${createHash('sha1').update(svg).digest('hex')}"`;
    const headers: Record<string, string> = {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': cache,
      ETag: etag,
      'X-Signet-Badge-State': content.state,
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly runs no script and loads nothing.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag, X-Signet-Badge-State',
    };
    if (cache !== 'no-store' && matchIfNoneMatch(req.headers.get('If-None-Match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(req.method === 'HEAD' ? null : svg, { status: 200, headers });
  };
}
