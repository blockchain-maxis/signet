import { rpc } from '@stellar/stellar-sdk';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { createRegistryReader, type RegistryReader } from './registry-read.js';
import { applyAttestation, type AttestationStore } from './workers/attestation.js';

export interface DevSeedStore extends AttestationStore {
  wallet: AttestationStore['wallet'] & {
    update(args: {
      where: { pubkey: string };
      data: { indexRequestedAt: Date };
    }): Promise<unknown>;
  };
}

export interface DevSeedOptions {
  handle: string;
  iKnow?: boolean;
  network?: string;
  databaseUrl?: string;
  nodeEnv?: string;
}

export interface DevSeedDeps {
  store: DevSeedStore;
  reader: RegistryReader;
  logger?: {
    info: (fields: Record<string, unknown>, msg: string) => void;
    warn: (fields: Record<string, unknown>, msg: string) => void;
    error: (fields: Record<string, unknown>, msg: string) => void;
  };
}

const ALLOWED_LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'signet-postgres',
  'signet-db',
  'db',
]);

export function validateDevSeedEnvironment(options: DevSeedOptions): void {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'production' && !options.iKnow) {
    throw new Error('Refusing to run dev:seed in production without --i-know');
  }

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl && !options.iKnow) {
    try {
      const url = new URL(databaseUrl);
      const hostname = url.hostname.toLowerCase();
      if (!ALLOWED_LOCAL_HOSTS.has(hostname)) {
        throw new Error(
          `Refusing to run dev:seed against non-local database host "${hostname}" without --i-know`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Refusing')) {
        throw err;
      }
    }
  }
}

export async function runDevSeed(
  options: DevSeedOptions,
  deps: DevSeedDeps,
): Promise<{ handle: string; wallet: string }> {
  if (!options.handle || typeof options.handle !== 'string') {
    throw new Error('Handle is required (--handle <handle>)');
  }

  validateDevSeedEnvironment(options);

  const network = options.network ?? 'testnet';
  const resolved = await deps.reader.resolveMany([options.handle]);
  const wallet = resolved[0];

  if (!wallet) {
    const errorMsg = `handle not claimed on ${network}`;
    deps.logger?.error({ handle: options.handle, network }, errorMsg);
    throw new Error(errorMsg);
  }

  // Tagged rather than left to default to 'attestation-worker': this binding
  // was applied by a developer running dev:seed by hand, not observed on the
  // registry's event stream, and the pairing audit log must say so.
  await applyAttestation(deps.store, {
    kind: 'claimed',
    handle: options.handle,
    wallet,
    source: 'dev-seed',
  });

  await deps.store.wallet.update({
    where: { pubkey: wallet },
    data: { indexRequestedAt: new Date() },
  });

  deps.logger?.info(
    { handle: options.handle, wallet, indexRequestedAt: true },
    'dev-seed.completed',
  );

  return { handle: options.handle, wallet };
}

function parseCliArgs(argv: string[]): { handle: string; iKnow: boolean } {
  let handle = '';
  let iKnow = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--handle') {
      handle = argv[++i] ?? '';
    } else if (arg.startsWith('--handle=')) {
      handle = arg.slice('--handle='.length);
    } else if (arg === '--i-know') {
      iKnow = true;
    }
  }

  return { handle, iKnow };
}

async function main() {
  const { handle, iKnow } = parseCliArgs(process.argv.slice(2));
  if (!handle) {
    console.error('Usage: pnpm dev:seed --handle <handle> [--i-know]');
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!config.registryContractId) {
    console.error(
      'INDEXER_REGISTRY_CONTRACT_ID or NEXT_PUBLIC_IDENTITY_REGISTRY_ID must be set',
    );
    process.exit(1);
  }

  const server = new rpc.Server(config.rpcUrl);
  const reader = createRegistryReader(
    server,
    config.registryContractId,
    config.network,
  );

  try {
    await runDevSeed(
      {
        handle,
        iKnow,
        network: config.network,
        databaseUrl: config.databaseUrl,
        nodeEnv: process.env.NODE_ENV,
      },
      {
        store: prisma as unknown as DevSeedStore,
        reader,
        logger,
      },
    );
    console.log(`Successfully seeded handle "${handle}"`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('dev-seed.ts') || process.argv[1]?.endsWith('dev-seed.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
