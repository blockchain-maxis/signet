/**
 * @file The call form's model (#581): one field per argument, derived from
 * the spec, never hand-written, so every contract gets a usable form.
 *
 * The widget comes from the argument's spec type (`TypeRef`), which says more
 * than the JSON Schema (an `Option`, a `BytesN`'s length, a map). What the
 * form submits is the `functionArgsSchema` shape the simulator encodes
 * (#438, #545): 64-bit and wider integers as decimal strings, bytes as
 * base64, maps as `[key, value]` pairs, unions as `{tag, values}`, enums as
 * numbers, an absent `Option` left out. That JSON is then checked against the
 * same schema before it is sent.
 *
 * Pure, so it is tested without a browser.
 */

import { StrKey } from '@stellar/stellar-sdk';
import type { SpecField, SpecJson, SpecType, TypeRef } from '@signet/spec';

export type IntType = 'u32' | 'i32';
export type BigIntType = 'u64' | 'i64' | 'u128' | 'i128' | 'u256' | 'i256' | 'timepoint' | 'duration';

/** What a widget edits. */
export type Field =
  | { readonly kind: 'address'; readonly muxed: boolean }
  | { readonly kind: 'bool' }
  | { readonly kind: 'int'; readonly type: IntType }
  | { readonly kind: 'bigint'; readonly type: BigIntType }
  | { readonly kind: 'text'; readonly type: 'string' | 'symbol' }
  | { readonly kind: 'bytes'; readonly length?: number }
  | { readonly kind: 'option'; readonly inner: Field }
  | { readonly kind: 'vec'; readonly item: Field }
  | { readonly kind: 'map'; readonly key: Field; readonly value: Field }
  | { readonly kind: 'tuple'; readonly items: readonly Field[] }
  | { readonly kind: 'struct'; readonly name: string; readonly fields: readonly { name: string; doc?: string; field: Field }[] }
  | { readonly kind: 'union'; readonly name: string; readonly cases: readonly { name: string; doc?: string; fields: readonly Field[] }[] }
  | { readonly kind: 'enum'; readonly name: string; readonly variants: readonly { name: string; doc?: string; value: number }[] }
  | { readonly kind: 'raw'; readonly type: string };

/** What the form holds for a field, before it becomes argument JSON. */
export type Value =
  | string
  | boolean
  | null
  | { present: boolean; value: Value }
  | Value[]
  | [Value, Value][]
  | { [name: string]: Value }
  | { tag: string; values: Value[] };

const MAX_DEPTH = 12;

/** The field for a spec type; a recursive named type stops at `MAX_DEPTH` as raw JSON. */
export function fieldOf(type: TypeRef, types: readonly SpecType[], depth = 0): Field {
  if (depth > MAX_DEPTH) return { kind: 'raw', type: 'too deeply nested' };
  if (typeof type === 'string') {
    switch (type) {
      case 'address':
        return { kind: 'address', muxed: false };
      case 'muxedAddress':
        return { kind: 'address', muxed: true };
      case 'bool':
        return { kind: 'bool' };
      case 'u32':
      case 'i32':
        return { kind: 'int', type };
      case 'u64':
      case 'i64':
      case 'u128':
      case 'i128':
      case 'u256':
      case 'i256':
      case 'timepoint':
      case 'duration':
        return { kind: 'bigint', type };
      case 'string':
      case 'symbol':
        return { kind: 'text', type };
      case 'bytes':
        return { kind: 'bytes' };
      default:
        return { kind: 'raw', type };
    }
  }
  const next = (t: TypeRef) => fieldOf(t, types, depth + 1);
  switch (type.type) {
    case 'bytes_n':
      return { kind: 'bytes', length: type.n };
    case 'option':
      return { kind: 'option', inner: next(type.value) };
    case 'vec':
      return { kind: 'vec', item: next(type.element) };
    case 'map':
      return { kind: 'map', key: next(type.key), value: next(type.value) };
    case 'tuple':
      return { kind: 'tuple', items: type.elements.map(next) };
    case 'result':
      return next(type.ok);
    case 'named': {
      const def = types.find((t) => t.name === type.name);
      if (!def) return { kind: 'raw', type: type.name };
      if (def.kind === 'struct') {
        return {
          kind: 'struct',
          name: def.name,
          fields: def.fields.map((f: SpecField) => ({ name: f.name, ...(f.doc && { doc: f.doc }), field: next(f.type) })),
        };
      }
      if (def.kind === 'union') {
        return {
          kind: 'union',
          name: def.name,
          cases: def.cases.map((c) => ({ name: c.name, ...(c.doc && { doc: c.doc }), fields: c.fields.map((f) => next(f.type)) })),
        };
      }
      if (def.kind === 'enum') {
        return {
          kind: 'enum',
          name: def.name,
          variants: def.variants.map((v) => ({ name: v.name, ...(v.doc && { doc: v.doc }), value: v.value })),
        };
      }
      return { kind: 'raw', type: type.name };
    }
    default:
      return { kind: 'raw', type: type.xdrArm };
  }
}

/** A field's empty value. */
export function initialValue(field: Field): Value {
  switch (field.kind) {
    case 'bool':
      return false;
    case 'option':
      return { present: false, value: initialValue(field.inner) };
    case 'vec':
    case 'map':
      return [];
    case 'tuple':
      return field.items.map(initialValue);
    case 'struct':
      return Object.fromEntries(field.fields.map((f) => [f.name, initialValue(f.field)]));
    case 'union': {
      const first = field.cases[0];
      return { tag: first?.name ?? '', values: (first?.fields ?? []).map(initialValue) };
    }
    default:
      return '';
  }
}

const BOUNDS: Record<BigIntType, [bigint, bigint]> = {
  u64: [0n, 2n ** 64n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  u128: [0n, 2n ** 128n - 1n],
  i128: [-(2n ** 127n), 2n ** 127n - 1n],
  u256: [0n, 2n ** 256n - 1n],
  i256: [-(2n ** 255n), 2n ** 255n - 1n],
  timepoint: [0n, 2n ** 64n - 1n],
  duration: [0n, 2n ** 64n - 1n],
};

/** Field errors by path (`wallet`, `handles[2]`, `v.inner.value`). */
export type Errors = Record<string, string>;

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * A value as argument JSON. Errors are collected by path, not thrown, so
 * every bad field shows at once; `undefined` means "leave it out" (an absent
 * Option).
 */
export function toJson(field: Field, value: Value, path: string, errors: Errors): unknown {
  const fail = (message: string) => {
    errors[path] = message;
    return undefined;
  };
  const text = typeof value === 'string' ? value.trim() : '';
  switch (field.kind) {
    case 'address': {
      if (!text) return fail('required');
      const ok = StrKey.isValidEd25519PublicKey(text) || StrKey.isValidContract(text) || (field.muxed && StrKey.isValidMed25519PublicKey(text));
      return ok ? text : fail(`expected an account (G…) or contract (C…) address${field.muxed ? ', or a muxed one (M…)' : ''}`);
    }
    case 'bool':
      return value === true;
    case 'int': {
      if (!/^-?\d+$/.test(text)) return fail('expected a whole number');
      const n = Number(text);
      const [min, max] = field.type === 'u32' ? [0, 4_294_967_295] : [-2_147_483_648, 2_147_483_647];
      return n < min || n > max ? fail(`out of range for ${field.type} (${min} to ${max})`) : n;
    }
    case 'bigint': {
      if (!/^-?\d+$/.test(text)) return fail('expected a whole number');
      const n = BigInt(text);
      const [min, max] = BOUNDS[field.type];
      return n < min || n > max ? fail(`out of range for ${field.type}`) : n.toString();
    }
    case 'text':
      if (field.type === 'symbol' && !/^[A-Za-z0-9_]{0,32}$/.test(text)) {
        return fail('a symbol is up to 32 letters, digits or _');
      }
      return typeof value === 'string' ? value : '';
    case 'bytes': {
      const hex = text.replace(/^0x/i, '');
      if (!/^([0-9a-fA-F]{2})*$/.test(hex)) return fail('expected hex, two digits per byte');
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (field.length !== undefined && bytes.length !== field.length) {
        return fail(`expected ${field.length} bytes, got ${bytes.length}`);
      }
      return bytesToBase64(bytes);
    }
    case 'option': {
      const v = value as { present: boolean; value: Value };
      return v.present ? toJson(field.inner, v.value, path, errors) : undefined;
    }
    case 'vec':
      return (value as Value[]).map((item, i) => toJson(field.item, item, `${path}[${i}]`, errors));
    case 'map':
      return (value as [Value, Value][]).map(([k, v], i) => [
        toJson(field.key, k, `${path}[${i}].key`, errors),
        toJson(field.value, v, `${path}[${i}].value`, errors),
      ]);
    case 'tuple':
      return field.items.map((f, i) => toJson(f, (value as Value[])[i] ?? initialValue(f), `${path}[${i}]`, errors));
    case 'struct': {
      const v = value as Record<string, Value>;
      const out: Record<string, unknown> = {};
      for (const f of field.fields) {
        const json = toJson(f.field, v[f.name] ?? initialValue(f.field), `${path}.${f.name}`, errors);
        if (json !== undefined) out[f.name] = json;
      }
      return out;
    }
    case 'union': {
      const v = value as { tag: string; values: Value[] };
      const c = field.cases.find((x) => x.name === v.tag);
      if (!c) return fail('choose a variant');
      return c.fields.length
        ? { tag: c.name, values: c.fields.map((f, i) => toJson(f, v.values[i] ?? initialValue(f), `${path}.${c.name}[${i}]`, errors)) }
        : { tag: c.name };
    }
    case 'enum': {
      const variant = field.variants.find((x) => String(x.value) === text);
      return variant ? variant.value : fail('choose a variant');
    }
    case 'raw': {
      if (!text) return fail('required (JSON)');
      try {
        return JSON.parse(text);
      } catch {
        return fail('expected JSON');
      }
    }
  }
}

export interface FormArg {
  readonly name: string;
  readonly doc?: string;
  readonly field: Field;
}

/** The form's arguments for a function of the spec. */
export function formFor(spec: SpecJson, fn: string): FormArg[] {
  const f = spec.functions.find((x) => x.name === fn);
  if (!f) return [];
  return f.inputs.map((i) => ({ name: i.name, ...(i.doc && { doc: i.doc }), field: fieldOf(i.type, spec.types) }));
}

/** Every argument as JSON, keyed by name, and the field errors. */
export function argsJson(args: readonly FormArg[], values: Record<string, Value>): { args: Record<string, unknown>; errors: Errors } {
  const errors: Errors = {};
  const out: Record<string, unknown> = {};
  for (const a of args) {
    const json = toJson(a.field, values[a.name] ?? initialValue(a.field), a.name, errors);
    if (json !== undefined) out[a.name] = json;
  }
  return { args: out, errors };
}

// ── The same schema, checked (#438) ─────────────────────────────────────

type Schema = Record<string, unknown>;

/**
 * A small JSON-Schema (draft 7) check over the subset `functionArgsSchema`
 * emits: `$ref`, `type`, `pattern`, length and range bounds, `enum`,
 * `const`, `oneOf`, tuple and list `items`, and object `properties`,
 * `required` and `additionalProperties: false`. Errors use the form's paths.
 */
export function checkSchema(schema: Schema, value: unknown, root: Schema = schema, path = ''): Errors {
  const errors: Errors = {};
  const at = (p: string) => p || 'arguments';
  const walk = (s: Schema, v: unknown, p: string): boolean => {
    if (typeof s.$ref === 'string') {
      const def = (root.definitions as Record<string, Schema> | undefined)?.[s.$ref.replace('#/definitions/', '')];
      if (def && !walk(def, v, p)) return false;
    }
    if (Array.isArray(s.oneOf)) {
      const ok = (s.oneOf as Schema[]).filter((o) => Object.keys(checkSchema(o, v, root, p)).length === 0);
      if (ok.length !== 1) {
        errors[at(p)] = 'does not match any one variant';
        return false;
      }
    }
    if (s.const !== undefined && v !== s.const) return (errors[at(p)] = `expected ${JSON.stringify(s.const)}`), false;
    if (Array.isArray(s.enum) && !s.enum.includes(v)) return (errors[at(p)] = 'not one of the allowed values'), false;
    const type = s.type as string | undefined;
    const is: Record<string, (x: unknown) => boolean> = {
      object: (x) => typeof x === 'object' && x !== null && !Array.isArray(x),
      array: Array.isArray,
      string: (x) => typeof x === 'string',
      integer: (x) => Number.isInteger(x),
      number: (x) => typeof x === 'number',
      boolean: (x) => typeof x === 'boolean',
    };
    if (type && is[type] && !is[type]!(v)) return (errors[at(p)] = `expected ${type}`), false;
    if (typeof v === 'string') {
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) return (errors[at(p)] = 'has the wrong format'), false;
      // The SDK's schema puts a BytesN's length on its base64 string as
      // maxLength; it is a byte count, so the decoded length is checked.
      const length = s.$ref === '#/definitions/DataUrl' ? atob(v).length : v.length;
      if (typeof s.minLength === 'number' && length < s.minLength) return (errors[at(p)] = 'too short'), false;
      if (typeof s.maxLength === 'number' && length > s.maxLength) return (errors[at(p)] = 'too long'), false;
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) return (errors[at(p)] = `below ${s.minimum}`), false;
      if (typeof s.maximum === 'number' && v > s.maximum) return (errors[at(p)] = `above ${s.maximum}`), false;
    }
    if (Array.isArray(v)) {
      if (Array.isArray(s.items)) {
        (s.items as Schema[]).forEach((item, i) => walk(item, v[i], `${p}[${i}]`));
      } else if (s.items && typeof s.items === 'object') {
        v.forEach((item, i) => walk(s.items as Schema, item, `${p}[${i}]`));
      }
    }
    if (is.object!(v) && (s.properties || s.required)) {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const name of (s.required as string[] | undefined) ?? []) {
        if (!(name in obj)) errors[p ? `${p}.${name}` : name] = 'required';
      }
      for (const [name, child] of Object.entries(obj)) {
        const sub = p ? `${p}.${name}` : name;
        if (props[name]) walk(props[name]!, child, sub);
        else if (s.additionalProperties === false) errors[sub] = 'not an argument of this function';
      }
    }
    return true;
  };
  walk(schema, value, path);
  return errors;
}

/**
 * A server error's field, from the simulator's `<path>: <reason>` message
 * (#545: `wallet: expected Address (G… or C…), got number`), or null.
 */
export function serverFieldError(message: string, args: readonly FormArg[]): { path: string; message: string } | null {
  const m = /(?:^|\s)(?:args\.)?([A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z0-9_]+)*):\s+(.+)$/.exec(message);
  if (!m || !args.some((a) => m[1] === a.name || m[1]!.startsWith(`${a.name}.`) || m[1]!.startsWith(`${a.name}[`))) return null;
  return { path: m[1]!, message: m[2]! };
}
