import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec } from '@signet/spec';
import { buildContractGraph, type TypeNode } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { limitTypeDepth } from './type-depth.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'fixtures');

function graph() {
  return buildContractGraph(parseContractSpec(readFileSync(join(FIXTURES, 'types_zoo.wasm'))));
}

const typeNode = (limited: ReturnType<typeof limitTypeDepth>, name: string): TypeNode | undefined =>
  limited.nodes.find((node) => node.id === `type:${name}`) as TypeNode | undefined;

test('the default depth keeps direct types and stubs the ones below them', () => {
  const limited = limitTypeDepth(graph());

  assert.equal(typeNode(limited, 'Level1')?.stub, undefined);
  assert.equal(typeNode(limited, 'Level2')?.stub, true);
  assert.equal(typeNode(limited, 'Level3')?.stub, true);
  assert.equal(typeNode(limited, 'Level2')?.hidden, 1);
  assert.equal(
    limited.edges.some((edge) => edge.from === 'type:Level2'),
    false,
    'a stub draws no member edges',
  );
});

test('expandTypes opens one more level and no further', () => {
  const limited = limitTypeDepth(graph(), { expandTypes: ['Level2'] });

  assert.equal(typeNode(limited, 'Level2')?.stub, undefined);
  assert.equal(typeNode(limited, 'Level3')?.stub, true);
  assert.ok(limited.edges.some((edge) => edge.from === 'type:Level2'));
  assert.equal(
    limited.edges.some((edge) => edge.from === 'type:Level3'),
    false,
  );
});

test('a raised typeDepth opens the whole reachable chain', () => {
  const limited = limitTypeDepth(graph(), { typeDepth: Infinity });
  assert.ok(limited.nodes.every((node) => node.kind !== 'type' || node.stub !== true));
  assert.equal(limited.edges.length, graph().edges.length);
});

test('typeDepth 0 stubs every type', () => {
  const limited = limitTypeDepth(graph(), { typeDepth: 0 });
  assert.ok(limited.nodes.every((node) => node.kind !== 'type' || node.stub === true));
  assert.ok(limited.edges.every((edge) => !edge.from.startsWith('type:')));
});

test('the stub label and geometry reach the laid-out diagram', () => {
  const limited = limitTypeDepth(graph());
  const model = layoutContractGraph(limited);
  const level2 = model.nodes.find((node) => node.id === 'type:Level2');
  assert.equal(level2?.label, 'Level2 +1');
  assert.equal(level2?.name, 'Level2');
});

test('limiting is deterministic and does not mutate the graph', () => {
  const original = graph();
  const before = JSON.stringify(original);
  const first = limitTypeDepth(original, { expandTypes: ['Level2'] });
  const second = limitTypeDepth(original, { expandTypes: ['Level2'] });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(original), before);
});
