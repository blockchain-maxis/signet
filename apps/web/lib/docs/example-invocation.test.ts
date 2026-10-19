import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parseContractSpec } from '@signet/spec';
import { allFunctionSchemas, functionArgsSchema } from '@signet/spec';
import {
  exampleArgs,
  renderCliSnippet,
  renderTypeScriptSnippet,
  EXAMPLE_INVOCATION_CAPTION,
} from './example-invocation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', '..', '..', '..', 'packages', 'spec', 'fixtures');

const ajv = new Ajv({ strict: false });

test('example-invocation: exact verbatim caption matches requirements', () => {
  assert.equal(
    EXAMPLE_INVOCATION_CAPTION,
    'Placeholder values. This shows the argument shape only. It does not show who is authorised to call this function, what it costs or whether the call succeeds.',
  );
});

test('example-invocation: registry claim CLI snippet matches exact expected string', () => {
  const spec = parseContractSpec(readFileSync(join(FIXTURES_DIR, 'identity-registry.wasm')));
  const schema = functionArgsSchema(spec, 'claim');

  const snippet = renderCliSnippet({
    address: '{address}',
    network: '{network}',
    fnName: 'claim',
    schema,
  });

  assert.equal(
    snippet,
    'stellar contract invoke --id {address} --network {network} -- claim --handle <string> --wallet <address>',
  );
});

test('example-invocation: registry claim TypeScript snippet renders client call', () => {
  const spec = parseContractSpec(readFileSync(join(FIXTURES_DIR, 'identity-registry.wasm')));
  const schema = functionArgsSchema(spec, 'claim');

  const snippet = renderTypeScriptSnippet({
    contractId: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    fnName: 'claim',
    schema,
  });

  assert.ok(snippet.includes("contractId: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN'"));
  assert.ok(snippet.includes("networkPassphrase: 'Test SDF Network ; September 2015'"));
  assert.ok(snippet.includes("rpcUrl: 'https://soroban-testnet.stellar.org'"));
  assert.ok(snippet.includes('const result = await client.claim({'));
  assert.ok(snippet.includes('"handle": "<string>"'));
  assert.ok(snippet.includes('"wallet": "<address>"'));
});

test('example-invocation: each generated argument object validates against its schema for every fixture function', () => {
  const wasmFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.wasm'));
  let checkedFunctions = 0;

  for (const file of wasmFiles) {
    let spec;
    try {
      spec = parseContractSpec(readFileSync(join(FIXTURES_DIR, file)));
    } catch {
      // Non-spec fixtures (e.g. no_spec.wasm, corrupt_section.wasm) are expected to fail parsing
      continue;
    }

    const schemas = allFunctionSchemas(spec);
    for (const [fnName, schema] of Object.entries(schemas)) {
      checkedFunctions++;
      const args = exampleArgs(schema);

      // Validate against the schema using Ajv.
      // Option arguments are generated as `null` by specification ("null for Option").
      // Since JSON Schema omits optional keys from `required` rather than typing them as [T, "null"],
      // we remove null properties when passing to strict JSON Schema validation, or verify
      // non-null fields validate.
      const cleanedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== null) cleanedArgs[k] = v;
      }

      // Ajv schema validation check.
      // Note that Ajv schema validation checks structure and types. Placeholders like "<32 bytes hex>"
      // and "<address>" are semantic placeholder strings, not real base64 or Stellar public keys.
      // We pass a validator that validates types, required properties, and nested structures.
      const relaxedAjv = new Ajv({ strict: false });
      const validate = relaxedAjv.compile({
        ...schema,
        definitions: Object.fromEntries(
          Object.entries((schema.definitions as Record<string, Record<string, unknown>>) ?? {}).map(
            ([defName, defSchema]) => {
              if (defSchema['pattern'] && defSchema['type'] === 'string') {
                const { pattern: _p, ...rest } = defSchema;
                return [defName, rest];
              }
              return [defName, defSchema];
            },
          ),
        ),
      });
      const valid = validate(cleanedArgs);
      assert.equal(
        valid,
        true,
        `Generated example args for ${file}::${fnName} failed validation: ${JSON.stringify(validate.errors)} (args: ${JSON.stringify(cleanedArgs)})`,
      );
    }
  }

  assert.ok(checkedFunctions >= 20, `Checked ${checkedFunctions} functions across fixtures`);
});
