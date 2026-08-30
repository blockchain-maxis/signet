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
  .command('link')
  .description('Link a deploy wallet to your profile')
  .option('--source <alias>', 'The Stellar CLI identity to use as the deploy key', 'deployer')
  .option('--app-url <url>', 'The Signet app URL', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')
  .action(async (options) => {
    const pubkey = getPubkey(options.source);
    
    console.log(`Linking deploy key (source: ${options.source}, ${pubkey})...`);
    
    const server = createServer();
    
    const tokenPromise = new Promise<{ token: string; handle: string }>((resolvePromise, rejectPromise) => {
      server.on('request', (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${(server.address() as any).port}`);
          if (url.pathname === '/callback') {
            const token = url.searchParams.get('token');
            const handle = url.searchParams.get('handle');
            
            if (!token || !handle) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>Error</h1><p>Missing token or handle.</p></body></html>');
              return rejectPromise(new Error('Missing token or handle in callback'));
            }
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Approved!</h1><p>You can close this window and return to your terminal.</p><script>window.close()</script></body></html>');
            resolvePromise({ token, handle });
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          rejectPromise(e);
        }
      });
    });

    server.listen(0, async () => {
      const port = (server.address() as any).port;
      const callbackUrl = `http://localhost:${port}/callback`;
      const approveUrl = `${options.appUrl}/app/cli/approve?pubkey=${pubkey}&callback=${encodeURIComponent(callbackUrl)}`;
      
      console.log(`Opening approval link in your browser:`);
      console.log(approveUrl);
      
      try {
        await open(approveUrl);
      } catch (e) {
        console.log(`Failed to open browser automatically. Please open the link manually.`);
      }

      try {
        const { token, handle } = await tokenPromise;
        server.close();
        
        console.log(`Received approval from web app. Verifying ownership...`);
        
        const secret = getSecret(options.source);
        const kp = Keypair.fromSecret(secret);
        const signature = kp.sign(Buffer.from(token, 'utf8')).toString('base64');
        
        const response = await fetch(`${options.appUrl}/api/cli/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, signature }),
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          console.error(`Failed to link wallet: ${data.error || response.statusText}`);
          process.exit(1);
        }
        
        console.log(`Successfully linked ${pubkey} to handle '@${handle}'.`);
      } catch (e: any) {
        server.close();
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
    });
  });



program.parse();
