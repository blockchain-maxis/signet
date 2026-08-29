/**
 * Normalization of browser CSP violation reports.
 *
 * Browsers disagree about both the shape and the transport of a violation
 * report, and a collector that understands only one of them silently drops the
 * other engine's traffic:
 *
 *   • `report-uri` (Firefox, Safari) POSTs `application/csp-report` with a
 *     single `{"csp-report": {...}}` object, hyphenated field names.
 *   • `report-to` / Reporting API (Chromium) POSTs `application/reports+json`
 *     with an *array* of envelopes, each `{type, url, body}`, camelCase field
 *     names inside `body`.
 *
 * This module flattens both into one `CspViolation` shape so the route handler
 * and anything downstream see a single record type.
 *
 * Everything here treats its input as hostile. The endpoint is unauthenticated
 * by necessity (the browser posts without credentials), so any field can be
 * absent, of the wrong type, or attacker-chosen — a page can be framed into
 * emitting reports with arbitrary `document-uri` and `blocked-uri` values.
 * Fields are therefore type-checked one by one and clamped to
 * [`MAX_FIELD_LEN`], so a report can never be used to flood the log pipeline
 * with a megabyte of attacker text per request.
 */

/** Longest string kept from any single report field; the rest is truncated. */
export const MAX_FIELD_LEN = 512;

/** Most violations accepted from one request body; the rest are ignored. */
export const MAX_REPORTS_PER_REQUEST = 20;

/** One violation, flattened from either wire format. */
export interface CspViolation {
  /** Page the violation happened on. */
  documentUri: string;
  /** Directive that was violated, e.g. `script-src 'self'`. */
  violatedDirective: string;
  /** Directive whose enforcement blocked it, e.g. `script-src`. */
  effectiveDirective: string;
  /** Resource the policy blocked, or `inline` / `eval`. */
  blockedUri: string;
  /** `enforce` for a live policy, `report` for report-only. */
  disposition: string;
  /** Where the offending markup/script came from, when the browser says. */
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  /** First bytes of the blocked inline script, when the browser includes it. */
  scriptSample?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed, length-clamped string, or `undefined` when the field is unusable. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_FIELD_LEN ? `${trimmed.slice(0, MAX_FIELD_LEN)}…` : trimmed;
}

/** A non-negative integer, or `undefined`. Line/column numbers only. */
function num(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * Read one violation out of a report body, accepting either field-naming
 * convention. Returns `null` when the body carries no directive at all — the
 * one field that makes a report worth recording.
 */
function normalizeBody(body: Record<string, unknown>): CspViolation | null {
  const violated = str(body['violated-directive']) ?? str(body.violatedDirective);
  const effective = str(body['effective-directive']) ?? str(body.effectiveDirective);
  if (!violated && !effective) return null;

  const violation: CspViolation = {
    documentUri: str(body['document-uri']) ?? str(body.documentURL) ?? 'unknown',
    violatedDirective: violated ?? effective!,
    effectiveDirective: effective ?? violated!,
    blockedUri: str(body['blocked-uri']) ?? str(body.blockedURL) ?? 'unknown',
    disposition: str(body.disposition) ?? 'enforce',
  };

  const sourceFile = str(body['source-file']) ?? str(body.sourceFile);
  if (sourceFile) violation.sourceFile = sourceFile;

  const lineNumber = num(body['line-number']) ?? num(body.lineNumber);
  if (lineNumber !== undefined) violation.lineNumber = lineNumber;

  const columnNumber = num(body['column-number']) ?? num(body.columnNumber);
  if (columnNumber !== undefined) violation.columnNumber = columnNumber;

  const sample = str(body['script-sample']) ?? str(body.sample);
  if (sample) violation.scriptSample = sample;

  return violation;
}

/**
 * Parse a decoded request body into zero or more violations.
 *
 * Never throws and never returns a partially-typed record: anything it cannot
 * make sense of yields an empty array, which the caller answers with a `204`
 * exactly like a well-formed report. Reports are fire-and-forget — a browser
 * does nothing useful with an error status, and a collector that 400s on an
 * unfamiliar dialect just turns a reporting gap into a retry loop.
 */
export function parseCspReports(payload: unknown): CspViolation[] {
  // Reporting API: an array of {type, body} envelopes, possibly mixed with
  // other report types (deprecation, intervention) that are not ours.
  if (Array.isArray(payload)) {
    const out: CspViolation[] = [];
    for (const entry of payload.slice(0, MAX_REPORTS_PER_REQUEST)) {
      if (!isRecord(entry)) continue;
      if (typeof entry.type === 'string' && entry.type !== 'csp-violation') continue;
      if (!isRecord(entry.body)) continue;
      const violation = normalizeBody(entry.body);
      if (violation) out.push(violation);
    }
    return out;
  }

  if (!isRecord(payload)) return [];

  // report-uri: a single {"csp-report": {...}} object.
  if (isRecord(payload['csp-report'])) {
    const violation = normalizeBody(payload['csp-report']);
    return violation ? [violation] : [];
  }

  // A bare body, which some tooling (and hand-rolled curl checks) sends.
  const violation = normalizeBody(payload);
  return violation ? [violation] : [];
}
