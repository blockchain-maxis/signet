#!/usr/bin/env node

import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { spawnSync } from 'node:child_process';
import * as dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '../../.env') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

const program = new Command();

program
  .name('signet')
  .description('Signet CLI to manage developer profiles and deploy keys')
  .version('0.1.0');

program
  .command('link')
  .description('Link a deploy wallet to a handle')
  .argument('<handle>', 'The handle to link')
  .option('--source <alias>', 'The Stellar CLI identity to use as the deploy key', 'deployer')
  .option('--network <network>', 'The network to use (e.g. testnet, mainnet)', process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet')
  .option('--rpc-url <url>', 'The Soroban RPC URL', process.env.NEXT_PUBLIC_SOROBAN_RPC_URL)
  .option('--contract <id>', 'The Identity Registry contract ID', process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID)
  .action((handle, options) => {
    if (!options.contract) {
      console.error('Error: Contract ID is required. Pass --contract or set NEXT_PUBLIC_IDENTITY_REGISTRY_ID in .env');
      process.exit(1);
    }

    console.log(`Linking wallet (source: ${options.source}) to handle '${handle}'...`);
    const args = [
      'contract', 'invoke',
      '--id', options.contract,
      '--source', options.source,
    ];
    
    if (options.network) {
      args.push('--network', options.network);
    } else if (options.rpcUrl) {
      args.push('--rpc-url', options.rpcUrl);
    }
    
    args.push('--', 'claim', '--handle', handle);

    const result = spawnSync('stellar', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('Failed to link wallet.');
      process.exit(result.status || 1);
    }
    console.log(`Successfully linked to handle '${handle}'.`);
  });

program
  .command('unlink')
  .description('Unlink a deploy wallet from its current handle')
  .argument('<handle>', 'The handle to unlink')
  .option('--source <alias>', 'The Stellar CLI identity to use as the deploy key', 'deployer')
  .option('--network <network>', 'The network to use (e.g. testnet, mainnet)', process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet')
  .option('--rpc-url <url>', 'The Soroban RPC URL', process.env.NEXT_PUBLIC_SOROBAN_RPC_URL)
  .option('--contract <id>', 'The Identity Registry contract ID', process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID)
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (handle, options) => {
    if (!options.contract) {
      console.error('Error: Contract ID is required. Pass --contract or set NEXT_PUBLIC_IDENTITY_REGISTRY_ID in .env');
      process.exit(1);
    }

    if (!options.yes) {
      const answer = await confirm({ message: `Are you sure you want to unlink the deploy wallet (source: ${options.source}) from the handle '${handle}'?` });
      if (!answer) {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    console.log(`Unlinking wallet from handle '${handle}'...`);
    const args = [
      'contract', 'invoke',
      '--id', options.contract,
      '--source', options.source,
    ];

    if (options.network) {
      args.push('--network', options.network);
    } else if (options.rpcUrl) {
      args.push('--rpc-url', options.rpcUrl);
    }

    args.push('--', 'release', '--handle', handle);

    const result = spawnSync('stellar', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('Failed to unlink wallet. Are you sure you control the deploy key for this handle?');
      process.exit(result.status || 1);
    }
    console.log(`Successfully unlinked wallet from handle '${handle}'.`);
  });

program.parse();
