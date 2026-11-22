export interface CallCommandInput {
  readonly contract?: string | undefined;
  readonly fn: string;
  readonly args: Record<string, unknown>;
  readonly authMode?: 'record' | 'strict' | undefined;
  readonly sourceAccount?: string | undefined;
  readonly ledgerSequence?: string | number | undefined;
  readonly ledgerTimestamp?: string | number | undefined;
  readonly network?: string | undefined;
  readonly runOn?: 'deployed' | 'local' | 'both' | undefined;
  readonly buildPath?: string | undefined;
}

/** Single-quote a value for POSIX shells, escaping any embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function token(value: string): string {
  return /^[A-Za-z0-9_.:/@-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Build the equivalent `signet sandbox call` CLI invocation for a Call form state.
 * Default flags (`--auth record`, unset source/ledger/timestamp) are omitted.
 */
export function buildCallCommand(input: CallCommandInput): string {
  const parts: string[] = [
    'signet',
    'sandbox',
    'call',
    token(input.contract?.trim() || '<contract>'),
    token(input.fn),
  ];

  for (const [name, value] of Object.entries(input.args)) {
    if (value === undefined) continue;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) continue;
    parts.push('--arg', shellQuote(`${name}=${serialized}`));
  }

  if (input.authMode && input.authMode !== 'record') {
    parts.push('--auth', token(input.authMode));
  }

  const source = input.sourceAccount?.trim();
  if (source) {
    parts.push('--source-account', token(source));
  }

  const seq =
    typeof input.ledgerSequence === 'number'
      ? String(input.ledgerSequence)
      : input.ledgerSequence?.trim();
  if (seq) {
    parts.push('--ledger-seq', token(seq));
  }

  const ts =
    typeof input.ledgerTimestamp === 'number'
      ? String(input.ledgerTimestamp)
      : input.ledgerTimestamp?.trim();
  if (ts) {
    parts.push('--timestamp', token(ts));
  }

  const network = input.network?.trim();
  if (network) {
    parts.push('--network', token(network));
  }

  let comment: string | null = null;
  if (input.runOn === 'local') {
    const wasm = input.buildPath?.trim();
    if (wasm) {
      parts.push('--wasm', shellQuote(wasm));
    } else {
      comment = '# Supply --wasm <path> with your local build path to target the local build.';
    }
  }

  const cmd = parts.join(' ');
  return comment ? `${comment}\n${cmd}` : cmd;
}
