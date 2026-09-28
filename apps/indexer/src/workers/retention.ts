const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Return the exclusive lower bound for a retention window, or `undefined`
 * when retention is disabled. Records exactly at the cutoff are retained.
 */
export function retentionCutoff(retentionDays: number, now: Date = new Date()): Date | undefined {
  if (retentionDays <= 0) return undefined;
  return new Date(now.getTime() - retentionDays * DAY_MS);
}
