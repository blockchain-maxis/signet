/**
 * @file @signet/spec
 *
 * Decode an XDR `string | Buffer` field to a JS string.
 */

/** Decode an XDR `string | Buffer` field to a JS string. */
export function xdrText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}
