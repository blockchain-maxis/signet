import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BindingGenerator } from '@stellar/stellar-sdk';
import { parseContractSpec } from '../src/parse.ts';
import { fromSpecJson, toSpecJson } from '../src/json.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'identity-registry.wasm');
const TEMP_DIR = join(__dirname, '..', '.smoke-client');

export function runSmokeCheck(): void {
  const wasm = readFileSync(FIXTURE_PATH);
  const parsed = parseContractSpec(wasm);
  const json = toSpecJson(parsed);
  const rebuilt = fromSpecJson(json);

  const generator = BindingGenerator.fromSpec(rebuilt.spec);
  const files = generator.generate({ contractName: 'identity-registry' });

  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(join(TEMP_DIR, 'src'), { recursive: true });

  try {
    writeFileSync(join(TEMP_DIR, 'package.json'), files.packageJson);
    writeFileSync(join(TEMP_DIR, 'tsconfig.json'), files.tsConfig);
    writeFileSync(join(TEMP_DIR, 'README.md'), files.readme);
    writeFileSync(join(TEMP_DIR, '.gitignore'), files.gitignore);
    writeFileSync(join(TEMP_DIR, 'src', 'index.ts'), files.index);
    writeFileSync(join(TEMP_DIR, 'src', 'client.ts'), files.client);
    if (files.types) {
      writeFileSync(join(TEMP_DIR, 'src', 'types.ts'), files.types);
    }

    execFileSync(
      'pnpm',
      ['exec', 'tsc', '--project', join(TEMP_DIR, 'tsconfig.json'), '--noEmit'],
      {
        cwd: join(__dirname, '..'),
        stdio: 'inherit',
      },
    );

    console.log(
      'Smoke check passed: generated TypeScript client compiles cleanly with tsc --noEmit.',
    );
  } finally {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

runSmokeCheck();
