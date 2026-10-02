/**
 * @file @signet/spec
 *
 * A minimal WebAssembly custom-section walker (§1.2 of docs/CONTRACT_DOCS_DESIGN.md).
 *
 * It reads the module header and the section framing — ids and LEB128 sizes —
 * and collects the payload of every custom section (id 0) by name. It compiles
 * nothing and validates nothing beyond the framing it has to trust to find the
 * next section.
 *
 * Why not `WebAssembly.Module.customSections`: it needs a compiled module, and
 * Chrome refuses synchronous compilation of modules over 4 KB on the main
 * thread — which is every real contract. Compiling is also wasted work when
 * all we want is a few bytes of metadata. Why not the SDK's own walker: it is
 * internal to `@stellar/stellar-sdk`.
 *
 * Deliberately no `fetch`, `fs` or `process` here: this module runs in the
 * browser as well as Node (`parse.test.ts` enforces it).
 */

import { InvalidWasm } from './errors.ts';

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"
const VERSION = [0x01, 0x00, 0x00, 0x00]; // 1, little-endian
const CUSTOM_SECTION_ID = 0;

/** Fatal so a malformed name is an invalid module, not a garbled map key. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Every custom section in `wasm`, keyed by name, in module order.
 *
 * A name maps to an array because the format allows a name to repeat;
 * `WebAssembly.Module.customSections` returns them all the same way. The
 * payloads are views into `wasm`, not copies.
 *
 * Throws `InvalidWasm` for a bad magic number or version, or for framing
 * that runs past the end of the buffer.
 */
export function readCustomSections(wasm: Uint8Array): Map<string, Uint8Array[]> {
  if (wasm.length < 8) throw new InvalidWasm(new Error('shorter than the 8-byte module header'));
  for (let i = 0; i < 4; i++) {
    if (wasm[i] !== MAGIC[i]) throw new InvalidWasm(new Error('bad magic number'));
    if (wasm[4 + i] !== VERSION[i]) throw new InvalidWasm(new Error('unsupported module version'));
  }

  const sections = new Map<string, Uint8Array[]>();
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos++]!;
    const [size, payloadStart] = readVarU32(wasm, pos);
    const end = payloadStart + size;
    if (end > wasm.length) {
      throw new InvalidWasm(new Error(`section ${id} runs past the end of the module`));
    }

    if (id === CUSTOM_SECTION_ID) {
      const [nameLength, nameStart] = readVarU32(wasm, payloadStart);
      const nameEnd = nameStart + nameLength;
      if (nameEnd > end)
        throw new InvalidWasm(new Error('custom section name runs past its section'));
      let name: string;
      try {
        name = utf8.decode(wasm.subarray(nameStart, nameEnd));
      } catch (cause) {
        throw new InvalidWasm(cause);
      }
      const payload = wasm.subarray(nameEnd, end);
      const existing = sections.get(name);
      if (existing) existing.push(payload);
      else sections.set(name, [payload]);
    }

    pos = end;
  }
  return sections;
}

/**
 * Decode an unsigned LEB128 u32 at `pos`, returning the value and the
 * position after it. At most 5 bytes, and the 5th may only carry 4 bits —
 * anything longer or larger is not a u32 and the module is malformed.
 */
function readVarU32(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= bytes.length) throw new InvalidWasm(new Error('truncated LEB128 integer'));
    const byte = bytes[pos++]!;
    if (i === 4 && byte > 0x0f) throw new InvalidWasm(new Error('LEB128 integer overflows u32'));
    result |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
  }
  throw new InvalidWasm(new Error('LEB128 integer longer than 5 bytes'));
}
