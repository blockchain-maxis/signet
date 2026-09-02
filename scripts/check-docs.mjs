#!/usr/bin/env node
/**
 * Docs drift guard — fails CI when markdown goes stale.
 *
 * Checks:
 *   (a) broken relative links and dead anchors in tracked *.md
 *   (b) env vars referenced in docs missing from .env.example, and vice versa
 *   (c) pnpm / cargo invocations in code fences that don't exist in package.json
 *       or the Cargo workspace
 *
 * Failures print file:line. Target runtime: well under 60s (no network).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function err(file, line, message) {
  const loc = line ? `${rel(file)}:${line}` : rel(file);
  errors.push(`${loc}: ${message}`);
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function walkMd(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'target') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkMd(p, out);
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** GitHub-flavoured heading slug. */
function slugify(heading) {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function collectAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!/^#{1,6}\s+\S/.test(line)) continue;
    let slug = slugify(line);
    const n = (counts.get(slug) ?? 0) + 1;
    counts.set(slug, n);
    if (n > 1) slug = `${slug}-${n - 1}`;
    anchors.add(slug);
  }
  return anchors;
}

// ── (a) links + anchors ─────────────────────────────────────────────

const mdFiles = walkMd(ROOT);
const anchorCache = new Map();

function anchorsFor(file) {
  if (!anchorCache.has(file)) {
    anchorCache.set(file, collectAnchors(fs.readFileSync(file, 'utf8')));
  }
  return anchorCache.get(file);
}

const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

for (const file of mdFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    // skip links inside inline/fenced code loosely: ignore lines that are pure fence
    if (/^\s*```/.test(line)) return;
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(line))) {
      let href = m[2].trim();
      // strip optional title: url "title"
      const sp = href.match(/^<?([^\s>]+)>?(?:\s+["'].*)?$/);
      if (sp) href = sp[1];
      if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
        continue;
      }

      const hashIdx = href.indexOf('#');
      const filePart = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const anchor = hashIdx === -1 ? '' : href.slice(hashIdx + 1);

      let targetFile = file;
      if (filePart) {
        targetFile = path.normalize(path.join(path.dirname(file), decodeURIComponent(filePart)));
        if (!fs.existsSync(targetFile)) {
          err(file, idx + 1, `broken relative link → ${href}`);
          continue;
        }
      }

      if (anchor) {
        if (!targetFile.endsWith('.md')) continue; // non-md anchors not checked
        const anchors = anchorsFor(targetFile);
        if (!anchors.has(anchor.toLowerCase()) && !anchors.has(anchor)) {
          err(file, idx + 1, `dead anchor → ${href}`);
        }
      }
    }
  });
}

// ── (b) env vars ────────────────────────────────────────────────────

const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const exampleText = fs.readFileSync(ENV_EXAMPLE, 'utf8');
const exampleVars = new Set();
for (const line of exampleText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*=/);
  if (m) exampleVars.add(m[1]);
}

/** Standard / non-app env names that docs may mention without listing in .env.example. */
const ENV_ALLOW = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'CI',
  'GITHUB_ACTIONS',
  'DEPLOY_ENABLED', // GitHub repo variable, not app env
  'BUDGET_BYTES', // CI workflow env
  'DEMO_HORIZON_URL', // GitHub repo variable, not app env
  'DEMO_WALLETS_REQUIRE_HORIZON', // GitHub repo variable, not app env
  'NETWORK', // shell override for deploy-contract.sh
  'STELLAR_ACCOUNT', // shell override for deploy-contract.sh
  'ADMIN_ADDRESS', // shell override for deploy-contract.sh
  'SIGNET_URL', // shell env for the cli/ Go module, not the pnpm workspace's .env
  'WAYLAND_DISPLAY', // standard desktop-session env var, not app config
  'CLI_RELEASE_ENABLED', // GitHub repo variable, not app env — see release-cli.yml
  'NPM_TOKEN', // GitHub Actions secret, not app env — see release-cli.yml
]);

/**
 * Exported code identifiers that happen to be SCREAMING_SNAKE. Docs cite these
 * as symbols, not configuration, so requiring them in `.env.example` would be
 * wrong — and the alternative (not backticking a real identifier) is worse.
 * Add to this list rather than weakening the pattern below.
 */
const NOT_ENV_IDENTIFIERS = new Set([
  'DEMO_PROFILES', // packages/types — the shared demo personas
  'RESERVED_HANDLES', // packages/types
  'HANDLE_MAX_LEN', // packages/types
  'BASE_FEE', // @stellar/stellar-sdk constant
  'MAX_BATCH_SIZE', // identity-registry contract constant
  'MAX_HANDLE_LEN', // identity-registry contract constant
  'DB_OPERATIONS_PER_WALLET', // apps/web/lib/profiles.ts — bounded read, not config
  'HORIZON_MAX_RECORDS', // apps/web/lib/server/horizon.ts — bounded read, not config
]);

/** Backticked SCREAMING_SNAKE with an underscore — typical env var citation. */
const ENV_REF_RE = /`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g;

const docsVars = new Map(); // var -> [{file,line}]
for (const file of mdFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    ENV_REF_RE.lastIndex = 0;
    let m;
    while ((m = ENV_REF_RE.exec(line))) {
      const name = m[1];
      if (ENV_ALLOW.has(name) || NOT_ENV_IDENTIFIERS.has(name)) continue;
      if (!docsVars.has(name)) docsVars.set(name, []);
      docsVars.get(name).push({ file, line: idx + 1 });
    }
  });
}

for (const [name, refs] of docsVars) {
  if (!exampleVars.has(name)) {
    const { file, line } = refs[0];
    err(file, line, `env var \`${name}\` referenced in docs but absent from .env.example`);
  }
}

for (const name of exampleVars) {
  if (!docsVars.has(name)) {
    err(ENV_EXAMPLE, null, `env var \`${name}\` in .env.example is not referenced in any tracked *.md`);
  }
}

// ── (c) pnpm / cargo scripts in fences ──────────────────────────────

function loadPackageScripts() {
  const scripts = new Map(); // package name or "" (root) -> Set<script>
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  scripts.set('', new Set(Object.keys(rootPkg.scripts ?? {})));
  scripts.set(rootPkg.name ?? 'signet', new Set(Object.keys(rootPkg.scripts ?? {})));

  function scanPkg(dir) {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.name) scripts.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
  }
  for (const base of ['apps', 'packages']) {
    const baseDir = path.join(ROOT, base);
    if (!fs.existsSync(baseDir)) continue;
    for (const ent of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (ent.isDirectory()) scanPkg(path.join(baseDir, ent.name));
    }
  }
  return scripts;
}

const packageScripts = loadPackageScripts();

const PNPM_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'exec',
  'dlx',
  'run',
  'test',
  'start',
  'publish',
  'update',
  'outdated',
  'list',
  'ls',
  'why',
  'store',
  'config',
  'env',
  'fetch',
  'link',
  'unlink',
  'rebuild',
  'prune',
  'audit',
  'approve-builds',
  'create',
  'init',
  'import',
  'deploy',
  'patch',
  'patch-commit',
  'help',
  'recursive',
  'multi',
  '-r',
  '-w',
  '--filter',
  '-F',
  '--dir',
  '-C',
  // Workspace binaries invoked as `pnpm <bin>` rather than package scripts.
  'turbo',
]);

const CARGO_SUBCOMMANDS = new Set([
  'build',
  'test',
  'check',
  'run',
  'clippy',
  'fmt',
  'doc',
  'clean',
  'update',
  'tree',
  'install',
  'uninstall',
  'login',
  'publish',
  'search',
  'owner',
  'package',
  'bench',
  'init',
  'new',
  'add',
  'remove',
  'metadata',
  'fetch',
  'generate-lockfile',
  'locate-project',
  'vendor',
  'verify-project',
  'version',
  'help',
  'audit', // cargo-audit plugin, used in CI
]);

function extractFences(text) {
  const fences = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      const start = i + 1;
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
      fences.push({ startLine: start + 1, body: lines.slice(start, i).join('\n') });
    }
    i++;
  }
  return fences;
}

function checkPnpmLine(file, lineNo, line) {
  // Match pnpm invocations; ignore comments after #
  const cleaned = line.replace(/#.*$/, '').trim();
  if (!cleaned.includes('pnpm')) return;

  // pnpm --filter <pkg> <script>
  const filter = cleaned.match(/\bpnpm\s+--filter\s+(\S+)\s+(\S+)/);
  if (filter) {
    const [, pkg, script] = filter;
    if (script.startsWith('-')) return;
    const set = packageScripts.get(pkg);
    if (!set) {
      err(file, lineNo, `pnpm --filter package \`${pkg}\` not found in workspace`);
      return;
    }
    if (!set.has(script) && !PNPM_BUILTINS.has(script)) {
      err(file, lineNo, `pnpm script \`${script}\` not in package.json of \`${pkg}\``);
    }
    return;
  }

  // pnpm run <script>  OR  pnpm <script>
  const run = cleaned.match(/\bpnpm\s+(?:run\s+)?([a-zA-Z][\w:-]*)/);
  if (!run) return;
  const script = run[1];
  if (PNPM_BUILTINS.has(script)) return;
  // composite like db:up / db:down written as `pnpm db:up` / `db:down`
  const root = packageScripts.get('');
  if (!root.has(script)) {
    err(file, lineNo, `pnpm script \`${script}\` not in root package.json`);
  }
}

function checkCargoLine(file, lineNo, line) {
  const cleaned = line.replace(/#.*$/, '').trim();
  if (!cleaned.includes('cargo')) return;

  // cargo <subcommand>
  const m = cleaned.match(/\bcargo\s+([a-zA-Z][\w-]*)/);
  if (!m) return;
  const sub = m[1];
  if (!CARGO_SUBCOMMANDS.has(sub)) {
    err(file, lineNo, `cargo subcommand \`${sub}\` is not a known cargo/workspace command`);
  }

  const mp = cleaned.match(/--manifest-path\s+(\S+)/);
  if (mp) {
    const manifest = path.normalize(path.join(ROOT, mp[1]));
    if (!fs.existsSync(manifest)) {
      err(file, lineNo, `cargo --manifest-path not found → ${mp[1]}`);
    }
  }
}

// Also catch table cells like `pnpm db:up` / `db:down` outside fences (README scripts table)
const PNPM_INLINE_RE = /`pnpm\s+((?:--filter\s+\S+\s+)?[a-zA-Z][\w:-]*)`/g;
const PNPM_TABLE_RE = /`pnpm\s+([^`]+)`/g;

for (const file of mdFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const fence of extractFences(text)) {
    const flines = fence.body.split(/\r?\n/);
    flines.forEach((l, j) => {
      const lineNo = fence.startLine + j;
      // handle `pnpm db:up` / `db:down` style dual commands on one line
      const parts = l.split(/\s+\/\s+/);
      for (const part of parts) {
        checkPnpmLine(file, lineNo, part);
        checkCargoLine(file, lineNo, part);
      }
    });
  }

  // README-style tables: | `pnpm db:up` / `db:down` |
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (/^\s*```/.test(line)) return;
    PNPM_TABLE_RE.lastIndex = 0;
    let m;
    while ((m = PNPM_TABLE_RE.exec(line))) {
      const inner = m[1];
      // may be "db:up` / `db:down" after first split — handle full match body
      checkPnpmLine(file, idx + 1, `pnpm ${inner.split('`')[0].trim()}`);
    }
    // bare `db:up` / `db:down` after pnpm in same cell — already covered by first token
    // Match `pnpm db:up` / `db:down` second half
    const dual = line.match(/`pnpm\s+[^`]+`\s*\/\s*`([a-zA-Z][\w:-]*)`/);
    if (dual) {
      const root = packageScripts.get('');
      if (!root.has(dual[1])) {
        err(file, idx + 1, `pnpm script \`${dual[1]}\` not in root package.json`);
      }
    }
  });
}

// ── report ──────────────────────────────────────────────────────────

if (errors.length) {
  console.error(`docs check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(
  `docs check ok — ${mdFiles.length} markdown files, ${exampleVars.size} env vars, no drift`,
);
