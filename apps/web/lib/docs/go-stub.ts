import type { SpecField, SpecJson, SpecStruct, SpecType, TypeRef } from '@signet/spec';

/**
 * A deliberately thin Go client stub for a Soroban contract (#480).
 *
 * There is no maintained Soroban binding generator for Go, so this emits one
 * `.go` file with a struct per user-defined struct, a typed constant set per
 * integer enum, and, for each function, a func that turns typed arguments into
 * the `InvokeHostFunction` operation that calls it. That is all: no
 * simulation, signing, submission or result decoding. A type it has no
 * mapping for is taken as a raw `xdr.ScVal`, and the doc comment says so.
 *
 * The output is deterministic (no timestamp), so it can be snapshot-tested
 * and cached by WASM hash like the TypeScript stub.
 */

/** The Stellar Go SDK's current module path (the old github.com/stellar/go moved here). */
export const GO_SDK_MODULE = 'github.com/stellar/go-stellar-sdk';
/** The SDK release the generated code was compiled and vetted against. */
export const GO_SDK_VERSION = 'v0.7.3';

export interface GoStubMeta {
  address: string;
  network: string;
  wasmHash: string;
  contractName?: string;
}

const GO_KEYWORDS = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  // Identifiers the generated file itself declares or imports.
  'fmt',
  'strkey',
  'txnbuild',
  'xdr',
  'args',
  'err',
  'v',
  'invoke',
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** `transfer_from` -> `TransferFrom`; a leading digit gets an `F` prefix. */
export function goExported(name: string): string {
  const out = words(name)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
  if (out === '') return 'X';
  return /^[0-9]/.test(out) ? `F${out}` : out;
}

/** `transfer_from` -> `transferFrom`, never a Go keyword. */
function goLocal(name: string): string {
  const exported = goExported(name);
  const local = exported[0]!.toLowerCase() + exported.slice(1);
  return GO_KEYWORDS.has(local) ? `${local}_` : local;
}

/** A Go package name from the contract name: lowercase letters and digits only. */
function goPackage(name: string | undefined): string {
  const cleaned = (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pkg = /^[a-z]/.test(cleaned) ? cleaned : `contract${cleaned}`;
  return GO_KEYWORDS.has(pkg) ? `${pkg}pkg` : pkg;
}

function comment(text: string | undefined, indent = ''): string[] {
  if (!text || text.trim() === '') return [];
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${indent}// ${line.trimEnd()}`.trimEnd());
}

interface Mapping {
  /** Go type of the parameter or field. */
  go: string;
  /** Go expression of type `(xdr.ScVal, error)` converting `expr`. */
  conv: (expr: string) => string;
  /** False when the value is passed through as a raw xdr.ScVal. */
  typed: boolean;
}

const RAW: Mapping = { go: 'xdr.ScVal', conv: (e) => `scRaw(${e})`, typed: false };

const PRIMITIVES: Partial<Record<string, Mapping>> = {
  bool: { go: 'bool', conv: (e) => `scBool(${e})`, typed: true },
  u32: { go: 'uint32', conv: (e) => `scU32(${e})`, typed: true },
  i32: { go: 'int32', conv: (e) => `scI32(${e})`, typed: true },
  u64: { go: 'uint64', conv: (e) => `scU64(${e})`, typed: true },
  i64: { go: 'int64', conv: (e) => `scI64(${e})`, typed: true },
  timepoint: { go: 'uint64', conv: (e) => `scTimepoint(${e})`, typed: true },
  duration: { go: 'uint64', conv: (e) => `scDuration(${e})`, typed: true },
  string: { go: 'string', conv: (e) => `scString(${e})`, typed: true },
  symbol: { go: 'string', conv: (e) => `scSymbol(${e})`, typed: true },
  bytes: { go: '[]byte', conv: (e) => `scBytes(${e})`, typed: true },
  address: { go: 'string', conv: (e) => `scAddress(${e})`, typed: true },
};

/** A struct whose fields are all named `0`, `1`, ... is a tuple struct, encoded as a vec. */
function isTupleStruct(s: SpecStruct): boolean {
  return s.fields.length > 0 && s.fields.every((f) => /^[0-9]+$/.test(f.name));
}

class Generator {
  private readonly types: Map<string, SpecType>;

  constructor(types: readonly SpecType[]) {
    this.types = new Map(types.map((t) => [t.name, t]));
  }

  map(type: TypeRef): Mapping {
    if (typeof type === 'string') return PRIMITIVES[type] ?? RAW;
    switch (type.type) {
      case 'bytes_n':
        return { go: '[]byte', conv: (e) => `scBytes(${e})`, typed: true };
      case 'option': {
        const inner = this.map(type.value);
        if (!inner.typed) return RAW;
        return {
          go: `*${inner.go}`,
          conv: (e) =>
            `func(p *${inner.go}) (xdr.ScVal, error) {\n\t\tif p == nil {\n\t\t\treturn scVoid()\n\t\t}\n\t\treturn ${inner.conv('*p')}\n\t}(${e})`,
          typed: true,
        };
      }
      case 'vec': {
        const inner = this.map(type.element);
        if (!inner.typed) return RAW;
        return {
          go: `[]${inner.go}`,
          conv: (e) =>
            `func(s []${inner.go}) (xdr.ScVal, error) {\n\t\tout := make([]xdr.ScVal, 0, len(s))\n\t\tfor _, el := range s {\n\t\t\tv, err := ${inner.conv('el')}\n\t\t\tif err != nil {\n\t\t\t\treturn xdr.ScVal{}, err\n\t\t\t}\n\t\t\tout = append(out, v)\n\t\t}\n\t\treturn scVec(out)\n\t}(${e})`,
          typed: true,
        };
      }
      case 'named': {
        const udt = this.types.get(type.name);
        const name = goExported(type.name);
        if (udt?.kind === 'struct') return { go: name, conv: (e) => `${e}.ToScVal()`, typed: true };
        if (udt?.kind === 'enum')
          return { go: name, conv: (e) => `scU32(uint32(${e}))`, typed: true };
        return RAW;
      }
      default:
        // result, map, tuple, unknown: no typed mapping in a thin stub.
        return RAW;
    }
  }

  describe(type: TypeRef): string {
    if (typeof type === 'string') return type;
    switch (type.type) {
      case 'bytes_n':
        return `bytes_n<${type.n}>`;
      case 'option':
        return `Option<${this.describe(type.value)}>`;
      case 'result':
        return `Result<${this.describe(type.ok)}, ${this.describe(type.error)}>`;
      case 'vec':
        return `Vec<${this.describe(type.element)}>`;
      case 'map':
        return `Map<${this.describe(type.key)}, ${this.describe(type.value)}>`;
      case 'tuple':
        return `(${type.elements.map((t) => this.describe(t)).join(', ')})`;
      case 'named':
        return type.name;
      case 'unknown':
        return `unknown (${type.xdrArm})`;
    }
  }

  private fieldLine(f: SpecField): string[] {
    const m = this.map(f.type);
    const note = m.typed
      ? []
      : [`\t// Raw xdr.ScVal: ${this.describe(f.type)} has no typed mapping in this stub.`];
    return [...comment(f.doc, '\t'), ...note, `\t${goExported(f.name)} ${m.go}`];
  }

  struct(s: SpecStruct): string[] {
    const name = goExported(s.name);
    const lines = [...comment(s.doc), `type ${name} struct {`];
    for (const f of s.fields) lines.push(...this.fieldLine(f));
    lines.push('}', '');
    lines.push(`// ToScVal encodes ${name} the way the contract expects it.`);
    lines.push(`func (s ${name}) ToScVal() (xdr.ScVal, error) {`);
    if (isTupleStruct(s)) {
      lines.push(`\titems := make([]xdr.ScVal, 0, ${s.fields.length})`);
      for (const f of s.fields) {
        lines.push(`\tv${f.name}, err := ${this.map(f.type).conv(`s.${goExported(f.name)}`)}`);
        lines.push(
          '\tif err != nil {',
          `\t\treturn xdr.ScVal{}, fmt.Errorf("${s.name}.${f.name}: %w", err)`,
          '\t}',
        );
        lines.push(`\titems = append(items, v${f.name})`);
      }
      lines.push('\treturn scVec(items)', '}', '');
      return lines;
    }
    // A named-field struct is a map keyed by field name; Soroban expects the
    // keys in sorted order.
    const sorted = [...s.fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    lines.push(`\tentries := make([]xdr.ScMapEntry, 0, ${sorted.length})`);
    sorted.forEach((f, i) => {
      lines.push(`\tv${i}, err := ${this.map(f.type).conv(`s.${goExported(f.name)}`)}`);
      lines.push(
        '\tif err != nil {',
        `\t\treturn xdr.ScVal{}, fmt.Errorf("${s.name}.${f.name}: %w", err)`,
        '\t}',
      );
      lines.push(`\tk${i}, _ := scSymbol(${JSON.stringify(f.name)})`);
      lines.push(`\tentries = append(entries, xdr.ScMapEntry{Key: k${i}, Val: v${i}})`);
    });
    lines.push('\treturn scMap(entries)', '}', '');
    return lines;
  }

  enumType(e: Extract<SpecType, { kind: 'enum' }>): string[] {
    const name = goExported(e.name);
    const lines = [...comment(e.doc), `type ${name} uint32`, '', 'const ('];
    for (const v of e.variants) {
      lines.push(...comment(v.doc, '\t'), `\t${name}${goExported(v.name)} ${name} = ${v.value}`);
    }
    lines.push(')', '');
    return lines;
  }

  fn(f: SpecJson['functions'][number]): string[] {
    const name = `Build${goExported(f.name)}Op`;
    const params = f.inputs.map((i) => ({ local: goLocal(i.name), field: i, m: this.map(i.type) }));
    const lines = [`// ${name} builds the InvokeHostFunction operation that calls \`${f.name}\`.`];
    if (f.doc.trim() !== '') lines.push('//', ...comment(f.doc));
    for (const p of params.filter((p) => !p.m.typed)) {
      lines.push(
        `// ${p.local} is a raw xdr.ScVal: ${this.describe(p.field.type)} has no typed mapping in this stub.`,
      );
    }
    const sig = params.map((p) => `${p.local} ${p.m.go}`).join(', ');
    lines.push(`func ${name}(${sig}) (txnbuild.InvokeHostFunction, error) {`);
    lines.push(`\targs := make([]xdr.ScVal, 0, ${params.length})`);
    for (const p of params) {
      lines.push(`\t{`);
      lines.push(`\t\tv, err := ${p.m.conv(p.local).replace(/\n/g, '\n\t')}`);
      lines.push(
        '\t\tif err != nil {',
        `\t\t\treturn txnbuild.InvokeHostFunction{}, fmt.Errorf("${p.field.name}: %w", err)`,
        '\t\t}',
      );
      lines.push('\t\targs = append(args, v)', '\t}');
    }
    lines.push(`\treturn invoke(${JSON.stringify(f.name)}, args)`, '}', '');
    return lines;
  }
}

const HELPERS = `// ── helpers ──────────────────────────────────────────────────────────────

func invoke(function string, args []xdr.ScVal) (txnbuild.InvokeHostFunction, error) {
	raw, err := strkey.Decode(strkey.VersionByteContract, ContractID)
	if err != nil {
		return txnbuild.InvokeHostFunction{}, fmt.Errorf("contract id: %w", err)
	}
	var id xdr.ContractId
	copy(id[:], raw)
	return txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &id},
				FunctionName:    xdr.ScSymbol(function),
				Args:            args,
			},
		},
	}, nil
}

func scRaw(v xdr.ScVal) (xdr.ScVal, error) { return v, nil }

func scVoid() (xdr.ScVal, error) { return xdr.ScVal{Type: xdr.ScValTypeScvVoid}, nil }

func scBool(v bool) (xdr.ScVal, error) { return xdr.ScVal{Type: xdr.ScValTypeScvBool, B: &v}, nil }

func scU32(v uint32) (xdr.ScVal, error) {
	n := xdr.Uint32(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &n}, nil
}

func scI32(v int32) (xdr.ScVal, error) {
	n := xdr.Int32(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvI32, I32: &n}, nil
}

func scU64(v uint64) (xdr.ScVal, error) {
	n := xdr.Uint64(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvU64, U64: &n}, nil
}

func scI64(v int64) (xdr.ScVal, error) {
	n := xdr.Int64(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvI64, I64: &n}, nil
}

func scTimepoint(v uint64) (xdr.ScVal, error) {
	t := xdr.TimePoint(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvTimepoint, Timepoint: &t}, nil
}

func scDuration(v uint64) (xdr.ScVal, error) {
	d := xdr.Duration(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvDuration, Duration: &d}, nil
}

func scString(v string) (xdr.ScVal, error) {
	s := xdr.ScString(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvString, Str: &s}, nil
}

func scSymbol(v string) (xdr.ScVal, error) {
	s := xdr.ScSymbol(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &s}, nil
}

func scBytes(v []byte) (xdr.ScVal, error) {
	b := xdr.ScBytes(v)
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &b}, nil
}

// scAddress accepts a G... account or a C... contract address.
func scAddress(v string) (xdr.ScVal, error) {
	var addr xdr.ScAddress
	if strkey.IsValidContractAddress(v) {
		raw, err := strkey.Decode(strkey.VersionByteContract, v)
		if err != nil {
			return xdr.ScVal{}, err
		}
		var id xdr.ContractId
		copy(id[:], raw)
		addr = xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &id}
	} else {
		account, err := xdr.AddressToAccountId(v)
		if err != nil {
			return xdr.ScVal{}, fmt.Errorf("address %q: %w", v, err)
		}
		addr = xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeAccount, AccountId: &account}
	}
	return xdr.ScVal{Type: xdr.ScValTypeScvAddress, Address: &addr}, nil
}

func scVec(items []xdr.ScVal) (xdr.ScVal, error) {
	vec := xdr.ScVec(items)
	p := &vec
	return xdr.ScVal{Type: xdr.ScValTypeScvVec, Vec: &p}, nil
}

func scMap(entries []xdr.ScMapEntry) (xdr.ScVal, error) {
	m := xdr.ScMap(entries)
	p := &m
	return xdr.ScVal{Type: xdr.ScValTypeScvMap, Map: &p}, nil
}
`;

/** One `.go` file: the thin client stub for `spec`. */
export function generateGoStub(spec: SpecJson, meta: GoStubMeta): string {
  const gen = new Generator(spec.types);
  const pkg = goPackage(meta.contractName);
  const wasmHash = meta.wasmHash || spec.wasmHash;

  const out: string[] = [
    `// Package ${pkg} is a THIN client stub for a Soroban contract, generated by Signet.`,
    '//',
    `// Contract: ${meta.address}`,
    `// Network:  ${meta.network}`,
    `// WASM:     ${wasmHash}`,
    '//',
    '// It contains typed argument structs and, per function, a func that builds the',
    '// InvokeHostFunction operation. It does NOT simulate, sign, submit or decode',
    '// results: run the operation through simulateTransaction and your own signing',
    '// and submission. Types with no typed mapping are taken as a raw xdr.ScVal.',
    '//',
    `// Generated for WASM hash ${wasmHash}. If the contract is upgraded on-chain,`,
    '// regenerate this file: an older stub can build calls the new code rejects.',
    '//',
    `// Requires ${GO_SDK_MODULE} (written against ${GO_SDK_VERSION}).`,
    `package ${pkg}`,
    '',
    'import (',
    '\t"fmt"',
    '',
    `\t"${GO_SDK_MODULE}/strkey"`,
    `\t"${GO_SDK_MODULE}/txnbuild"`,
    `\t"${GO_SDK_MODULE}/xdr"`,
    ')',
    '',
    '// ContractID is the address every Build*Op func targets.',
    `const ContractID = ${JSON.stringify(meta.address)}`,
    '',
  ];

  const structs = spec.types.filter((t): t is SpecStruct => t.kind === 'struct');
  const enums = spec.types.filter(
    (t): t is Extract<SpecType, { kind: 'enum' }> => t.kind === 'enum',
  );
  const unions = spec.types.filter((t) => t.kind === 'union');

  if (structs.length > 0 || enums.length > 0 || unions.length > 0) {
    out.push('// ── types ────────────────────────────────────────────────────────────────', '');
  }
  for (const s of structs) out.push(...gen.struct(s));
  for (const e of enums) out.push(...gen.enumType(e));
  for (const u of unions) {
    out.push(
      `// ${goExported(u.name)} is a union: pass it as a raw xdr.ScVal (no typed mapping in this stub).`,
      '',
    );
  }

  const fns = spec.functions.filter((f) => !f.isConstructor);
  if (fns.length > 0) {
    out.push('// ── functions ────────────────────────────────────────────────────────────', '');
  }
  for (const f of fns) out.push(...gen.fn(f));
  if (spec.functions.some((f) => f.isConstructor)) {
    out.push('// The constructor runs at deploy time and is not part of this stub.', '');
  }

  out.push(HELPERS);
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
