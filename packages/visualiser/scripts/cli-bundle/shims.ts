/**
 * @file What the CLI bundle (#544) brings instead of host globals.
 *
 * The bundle runs in goja, a plain ECMAScript engine with no Node and no DOM.
 * The Stellar SDK's XDR layer reaches for `Buffer`, `TextEncoder` and
 * `TextDecoder`; esbuild's `inject` replaces each such global reference with
 * these exports, so the bundle carries its own and touches no global but
 * `globalThis.signetVisualise`, which it defines.
 *
 * Only UTF-8 is needed (contract specs are UTF-8 strings), so the text codecs
 * are UTF-8 alone, over the `buffer` package's encoder.
 */

import { Buffer } from 'buffer';

export { Buffer };

export class TextEncoder {
  readonly encoding = 'utf-8';
  encode(input = ''): Uint8Array {
    return new Uint8Array(Buffer.from(input, 'utf8'));
  }
}

export class TextDecoder {
  readonly encoding = 'utf-8';
  constructor(label = 'utf-8') {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`TextDecoder: only UTF-8, not ${label}`);
  }
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (input === undefined) return '';
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return Buffer.from(bytes).toString('utf8');
  }
}
