/**
 * Formats an ISO date string in a form that reads unambiguously regardless of
 * the reader's locale, e.g. "4 Mar 2026" rather than "3/4/2026" (US) or
 * "4/3/2026" (most of the rest of the world).
 *
 * Deliberately pinned to a fixed locale (`en-GB`, which orders day before
 * month) rather than the viewer's own locale — this page renders on the
 * server and hydrates on the client, and `Intl`'s locale-dependent output can
 * differ between the two environments, which would produce a hydration
 * mismatch.
 */
export function formatDate(iso: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...options,
  });
}
