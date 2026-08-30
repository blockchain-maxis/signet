#!/usr/bin/env node

import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import { spawnSync } from 'node:child_process';
import * as dotenv from 'dotenv';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import open from 'open';
import { Keypair } from '@stellar/stellar-sdk';

dotenv.config({ path: resolve(process.cwd(), '../../.env') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

const program = new Command();

program
  .name('signet')
  .description('Signet CLI to manage developer profiles and deploy keys')
  .version('0.1.0');

const getPubkey = (source: string): string => {
  const res = spawnSync('stellar', ['keys', 'address', source]);
  if (res.status !== 0) {
    console.error(`Error: Could not get public key for source '${source}'. Are you sure it exists?`);
    process.exit(1);
  }
  return res.stdout.toString().trim();
};

const getSecret = (source: string): string => {
  const res = spawnSync('stellar', ['keys', 'show', source]);
  if (res.status !== 0) {
    console.error(`Error: Could not get secret key for source '${source}'.`);
    process.exit(1);
  }
  return res.stdout.toString().trim();
};



program
  .command('unlink')
  .description('Unlink a deploy wallet from its current profile')
  .option('--source <alias>', 'The Stellar CLI identity to use as the deploy key', 'deployer')
  .option('--app-url <url>', 'The Signet app URL', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    const pubkey = getPubkey(options.source);
    
    if (!options.yes) {
      const answer = await confirm({ message: `Are you sure you want to unlink the deploy wallet (source: ${options.source}, ${pubkey}) from its profile?` });
      if (!answer) {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    console.log(`Unlinking wallet ${pubkey}...`);
    
    try {
      // 1. Fetch a generic challenge
      const challengeRes = await fetch(`${options.appUrl}/api/cli/challenge?pubkey=${pubkey}`);
      const challengeData = await challengeRes.json();
      
      if (!challengeRes.ok) {
        console.error(`Failed to fetch challenge: ${challengeData.error || challengeRes.statusText}`);
        process.exit(1);
      }
      
      // 2. Sign the challenge
      const secret = getSecret(options.source);
      const kp = Keypair.fromSecret(secret);
      const signature = kp.sign(Buffer.from(challengeData.challenge, 'utf8')).toString('base64');
      
      // 3. Post to unlink
      const response = await fetch(`${options.appUrl}/api/cli/unlink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey, challenge: challengeData.challenge, signature }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        console.error(`Failed to unlink wallet. Error: ${data.error || response.statusText}`);
        console.error('Are you sure you control the deploy key for this profile?');
        process.exit(1);
      }
      
      console.log(`Successfully unlinked wallet ${pubkey}.`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
