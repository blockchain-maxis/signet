import { pairingEvent, type PairingEventInput, type PairingOutcome } from '@signet/types';
import { logger } from '../logger.ts';

/** Which web-tier flow observed the pairing. */
export type WebPairingSource = 'cli-pairing' | 'cli-unlink';

/**
 * Correlation fields carried alongside the event: the pairing code and the
 * profile id tie an audit line to the operational lines around it. Neither is
 * key material; the signed XDR, the poll token and the handoff code never
 * appear here.
 */
export interface PairingCorrelation {
  state?: string;
  profileId?: string;
}

/**
 * Emit one pairing audit event from the web tier, in the shared vocabulary
 * `docs/INDEXER.md` tells operators to retain and query.
 *
 * Same levels as the indexer: `info` for every stage (production commonly
 * switches `debug` off), `warn` for a rejection. `pairingEvent` builds the
 * fields, so anything shaped like a secret throws instead of being logged.
 */
export function logPairing(
  outcome: PairingOutcome,
  input: PairingEventInput & { source: WebPairingSource },
  correlation: PairingCorrelation = {},
): void {
  const { name, fields } = pairingEvent(outcome, input);
  const line: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(correlation)) {
    if (value !== undefined) line[key] = value;
  }
  Object.assign(line, fields);
  if (outcome === 'rejected') logger.warn(line, name);
  else logger.info(line, name);
}
