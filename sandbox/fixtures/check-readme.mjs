#!/usr/bin/env node
/**
 * Checks the fixtures table in sandbox/fixtures/README.md against the code.
 *
 *   node sandbox/fixtures/check-readme.mjs [path/to/README.md]
 *
 * The table's last column names the tests that use each fixture contract, as
 * a file path followed by the tests in that file. Those names were once
 * written from memory and most of them did not exist, so this checks that:
 *
 *   - every fixture in the table has a WASM in wasm/, and every WASM a row;
 *   - every file path in the last column exists, under sandbox/ or cli/;
 *   - every test name exists in the file it is listed under: as `fn <name>`
 *     in a Rust file, or as `func <name>` or a `t.Run("<name>", ...)` subtest
 *     in a Go file;
 *   - that file names the fixture, so a test is not listed under the wrong
 *     one. For a Go file any test file of its package may name it, because a
 *     helper there (`session` in cli/internal/dev) installs it for the others.
 *
 * It does not look for tests that are missing from the table.
 *
 * No dependencies. Exits 1 with one line per problem.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const readme = path.resolve(process.argv[2] ?? path.join(here, 'README.md'));
const shown = path.relative(root, readme).split(path.sep).join('/');

const problems = [];
const problem = (line, message) => problems.push(`${shown}:${line}: ${message}`);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The rows of the table under "## Fixtures": its fixture, its last cell and its line number. */
function fixtureRows(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Fixtures\s*$/.test(line));
  if (start < 0) {
    problem(1, 'no "## Fixtures" section');
    return [];
  }
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    // The header row and the row of dashes under it.
    if (cells.every((cell) => /^[\s:-]*$/.test(cell)) || !cells[0].includes('`')) continue;
    rows.push({ line: i + 1, fixture: backticked(cells[0])[0], tests: cells[cells.length - 1] });
  }
  return rows;
}

const sources = new Map();
function source(file) {
  if (!sources.has(file)) {
    const full = path.join(root, file);
    sources.set(file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
  }
  return sources.get(file);
}

/** Whether `file` names the fixture: itself, or for Go, any test file of its package. */
function namesFixture(file, fixture) {
  const named = new RegExp(`\\b${escapeRe(fixture)}\\b`);
  if (!file.endsWith('.go')) return named.test(source(file));
  const dir = path.dirname(file);
  return fs
    .readdirSync(path.join(root, dir))
    .filter((entry) => entry.endsWith('_test.go'))
    .some((entry) => named.test(source(`${dir}/${entry}`)));
}

function hasTest(file, name) {
  const text = source(file);
  const id = escapeRe(name);
  if (file.endsWith('.rs')) return new RegExp(`\\bfn\\s+${id}\\s*[(<]`).test(text);
  if (file.endsWith('.go')) {
    return (
      new RegExp(`^func\\s+${id}\\s*\\(`, 'm').test(text) ||
      new RegExp(`\\bRun\\(\\s*"${id}"`).test(text)
    );
  }
  return false;
}

const rows = fixtureRows(fs.readFileSync(readme, 'utf8'));
const wasmDir = path.join(here, 'wasm');
const built = fs
  .readdirSync(wasmDir)
  .filter((file) => file.endsWith('.wasm'))
  .map((file) => file.slice(0, -'.wasm'.length));

let tests = 0;
const files = new Set();
for (const row of rows) {
  if (!built.includes(row.fixture)) {
    problem(
      row.line,
      `fixture \`${row.fixture}\` has no sandbox/fixtures/wasm/${row.fixture}.wasm`,
    );
  }
  let file = null;
  let named = 0;
  for (const token of backticked(row.tests)) {
    if (token.includes('/')) {
      file = token;
      if (!/^(sandbox|cli)\//.test(file)) {
        problem(row.line, `\`${file}\` is not under sandbox/ or cli/`);
        file = null;
      } else if (source(file) === null) {
        problem(row.line, `\`${file}\` does not exist`);
        file = null;
      } else {
        files.add(file);
        if (!namesFixture(file, row.fixture)) {
          problem(row.line, `\`${file}\` never names the fixture \`${row.fixture}\``);
        }
      }
      continue;
    }
    named++;
    if (file === null) {
      problem(row.line, `test \`${token}\` is not listed under a file that exists`);
    } else if (!hasTest(file, token)) {
      problem(row.line, `no test \`${token}\` in ${file}`);
    } else {
      tests++;
    }
  }
  if (named === 0) problem(row.line, `no test is named for the fixture \`${row.fixture}\``);
}
for (const fixture of built) {
  if (!rows.some((row) => row.fixture === fixture)) {
    problem(1, `sandbox/fixtures/wasm/${fixture}.wasm has no row in the fixtures table`);
  }
}

if (problems.length > 0) {
  console.error(
    `fixtures README check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`,
  );
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}
console.log(
  `fixtures README ok — ${rows.length} fixtures, ${tests} test names found in ${files.size} files`,
);
