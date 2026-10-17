import type { SpecJson } from './json.ts';

type Fn = SpecJson['functions'][number];
type Field = Fn['inputs'][number];
type SpecType = SpecJson['types'][number];
type ErrorCase = SpecJson['errors'][number];

export type SpecChangeKind =
  | 'function-added' | 'function-removed'
  | 'argument-added' | 'argument-removed'
  | 'argument-renamed' | 'argument-retyped'
  | 'return-type-changed' | 'documentation-changed'
  | 'type-added' | 'type-removed' | 'type-changed'
  | 'field-added' | 'field-removed' | 'field-renamed' | 'field-retyped'
  | 'case-added' | 'case-removed'
  | 'variant-added' | 'variant-removed' | 'variant-renumbered'
  | 'error-added' | 'error-removed' | 'error-renumbered'
  | 'event-changed'
  | 'spec-entries-changed';

export interface SpecChange {
  kind: SpecChangeKind;
  path: string;
  breaking: boolean;
  reason: string;
  before?: unknown;
  after?: unknown;
}

export interface SpecDiff {
  changes: SpecChange[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emit(
  changes: SpecChange[],
  kind: SpecChangeKind,
  path: string,
  breaking: boolean,
  reason: string,
  before?: unknown,
  after?: unknown,
): void {
  changes.push({
    kind,
    path,
    breaking,
    reason,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
}

function docs(
  changes: SpecChange[],
  path: string,
  before: string | undefined,
  after: string | undefined,
): void {
  if (before !== after) {
    emit(changes, 'documentation-changed', path, false,
      'Documentation changes do not alter the call interface.', before, after);
  }
}

function fields(
  changes: SpecChange[],
  before: readonly Field[],
  after: readonly Field[],
  path: string,
  args: boolean,
): void {
  const max = Math.max(before.length, after.length);

  for (let i = 0; i < max; i++) {
    const a = before[i];
    const b = after[i];

    if (!a && b) {
      emit(changes, args ? 'argument-added' : 'field-added',
        `${path}.${b.name}`, true,
        args ? 'Adding an argument changes the function signature.'
          : 'Adding a field changes the declared data shape.',
        undefined, b);
      continue;
    }

    if (a && !b) {
      emit(changes, args ? 'argument-removed' : 'field-removed',
        `${path}.${a.name}`, true,
        args ? 'Removing an argument changes the function signature.'
          : 'Removing a field changes the declared data shape.',
        a, undefined);
      continue;
    }

    if (!a || !b) continue;

    if (a.name !== b.name) {
      emit(changes, args ? 'argument-renamed' : 'field-renamed',
        `${path}[${i}]`, true,
        args ? 'Renaming an argument can break clients binding by name.'
          : 'Renaming a field can break clients referencing it by name.',
        a.name, b.name);
    }

    if (!same(a.type, b.type)) {
      emit(changes, args ? 'argument-retyped' : 'field-retyped',
        `${path}[${i}]`, true,
        args ? 'Changing an argument type can break existing callers.'
          : 'Changing a field type can break existing consumers.',
        a.type, b.type);
    }

    docs(changes, `${path}[${i}].doc`, a.doc, b.doc);
  }
}

function functions(
  changes: SpecChange[],
  before: readonly Fn[],
  after: readonly Fn[],
): void {
  const oldMap = new Map(before.map((f) => [f.name, f]));
  const newMap = new Map(after.map((f) => [f.name, f]));

  for (const old of before) {
    if (!newMap.has(old.name)) {
      emit(changes, 'function-removed', `functions.${old.name}`, true,
        'Removing a function breaks clients that call it.', old);
    }
  }

  for (const next of after) {
    if (!oldMap.has(next.name)) {
      emit(changes, 'function-added', `functions.${next.name}`, false,
        'Adding a function does not invalidate existing calls.', undefined, next);
    }
  }

  for (const old of before) {
    const next = newMap.get(old.name);
    if (!next) continue;

    const path = `functions.${old.name}`;
    fields(changes, old.inputs, next.inputs, `${path}.inputs`, true);

    if (!same(old.outputs, next.outputs)) {
      emit(changes, 'return-type-changed', `${path}.outputs`, true,
        'Changing return types can break clients expecting the previous result.',
        old.outputs, next.outputs);
    }

    docs(changes, `${path}.doc`, old.doc, next.doc);
  }
}

function types(
  changes: SpecChange[],
  before: readonly SpecType[],
  after: readonly SpecType[],
): void {
  const oldMap = new Map(before.map((t) => [t.name, t]));
  const newMap = new Map(after.map((t) => [t.name, t]));

  for (const old of before) {
    if (!newMap.has(old.name)) {
      emit(changes, 'type-removed', `types.${old.name}`, true,
        'Removing a type can break declarations that depend on it.', old);
    }
  }

  for (const next of after) {
    if (!oldMap.has(next.name)) {
      emit(changes, 'type-added', `types.${next.name}`, false,
        'Adding a type does not invalidate existing declarations.', undefined, next);
    }
  }

  for (const old of before) {
    const next = newMap.get(old.name);
    if (!next) continue;

    const path = `types.${old.name}`;

    if (old.kind !== next.kind) {
      emit(changes, 'type-changed', path, true,
        'Changing a type kind changes its declared interface.', old.kind, next.kind);
      continue;
    }

    docs(changes, `${path}.doc`, old.doc, next.doc);

    if (old.kind === 'struct' && next.kind === 'struct') {
      fields(changes, old.fields, next.fields, `${path}.fields`, false);
    } else if (old.kind === 'union' && next.kind === 'union') {
      const oldCases = new Map(old.cases.map((c) => [c.name, c]));
      const newCases = new Map(next.cases.map((c) => [c.name, c]));

      for (const c of old.cases) {
        if (!newCases.has(c.name)) {
          emit(changes, 'case-removed', `${path}.cases.${c.name}`, true,
            'Removing a union case can break consumers handling that case.', c);
        }
      }

      for (const c of next.cases) {
        if (!oldCases.has(c.name)) {
          emit(changes, 'case-added', `${path}.cases.${c.name}`, true,
            'Adding a union case can break exhaustive consumers.', undefined, c);
        }
      }

      for (const c of old.cases) {
        const n = newCases.get(c.name);
        if (!n) continue;
        docs(changes, `${path}.cases.${c.name}.doc`, c.doc, n.doc);
        fields(changes, c.fields, n.fields, `${path}.cases.${c.name}.fields`, false);
      }
    } else if (old.kind === 'enum' && next.kind === 'enum') {
      const oldVariants = new Map(old.variants.map((v) => [v.name, v]));
      const newVariants = new Map(next.variants.map((v) => [v.name, v]));

      for (const v of old.variants) {
        if (!newVariants.has(v.name)) {
          emit(changes, 'variant-removed', `${path}.variants.${v.name}`, true,
            'Removing an enum variant can break clients referencing it.', v);
        }
      }

      for (const v of next.variants) {
        const previous = oldVariants.get(v.name);

        if (!previous) {
          emit(changes, 'variant-added', `${path}.variants.${v.name}`, true,
            'Adding an enum variant can break exhaustive consumers.', undefined, v);
          continue;
        }

        if (previous.value !== v.value) {
          emit(changes, 'variant-renumbered', `${path}.variants.${v.name}`, true,
            'Changing a variant value breaks clients relying on its numeric value.',
            previous.value, v.value);
        }

        docs(changes, `${path}.variants.${v.name}.doc`, previous.doc, v.doc);
      }
    }
  }
}

function errors(
  changes: SpecChange[],
  before: readonly ErrorCase[],
  after: readonly ErrorCase[],
): void {
  const key = (e: ErrorCase) => `${e.enumName}.${e.name}`;
  const oldMap = new Map(before.map((e) => [key(e), e]));
  const newMap = new Map(after.map((e) => [key(e), e]));

  for (const old of before) {
    const next = newMap.get(key(old));

    if (!next) {
      emit(changes, 'error-removed', `errors.${key(old)}`, true,
        'Removing an error case can break existing error handling.', old);
      continue;
    }

    if (old.value !== next.value) {
      emit(changes, 'error-renumbered', `errors.${key(old)}`, true,
        'Changing an error value breaks clients matching its numeric code.',
        old.value, next.value);
    }

    docs(changes, `errors.${key(old)}.doc`, old.doc, next.doc);
  }

  for (const next of after) {
    if (!oldMap.has(key(next))) {
      emit(changes, 'error-added', `errors.${key(next)}`, false,
        'Adding an error preserves existing error identifiers and values.',
        undefined, next);
    }
  }
}

/** Compare callable interfaces; storage layout compatibility is out of scope. */
export function diffSpecs(before: SpecJson, after: SpecJson): SpecDiff {
  const changes: SpecChange[] = [];
  functions(changes, before.functions, after.functions);
  types(changes, before.types, after.types);
  errors(changes, before.errors, after.errors);
  if (!same(before.events, after.events)) {
    emit(
      changes,
      'event-changed',
      'events',
      true,
      'Changing contract events can break clients that depend on their names, parameters, topics, or data format.',
      before.events,
      after.events,
    );
  }

  // Until the parser exposes flattened interface views, preserve detection
  // of changes between real contract specs through their serialized entries.
  if (
    before.functions.length === 0 && after.functions.length === 0 &&
    before.types.length === 0 && after.types.length === 0 &&
    before.errors.length === 0 && after.errors.length === 0 &&
    !same(before.entriesXdr, after.entriesXdr)
  ) {
    emit(
      changes,
      'spec-entries-changed',
      'entriesXdr',
      true,
      'Raw contract spec entries differ; detailed interface comparison requires flattened parser views.',
      before.entriesXdr,
      after.entriesXdr,
    );
  }

  return { changes };
}
