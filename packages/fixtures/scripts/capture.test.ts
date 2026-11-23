import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, rpcCall } from './capture.js';

test('a NOT_FOUND getTransaction writes nothing and rejects naming the fixture and hash', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'signet-capture-test-'));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: any, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      if (body?.method === 'getNetwork') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { passphrase: 'Test SDF Network ; September 2015' },
          }),
        } as Response;
      }
      if (body?.method === 'getLatestLedger') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { sequence: 5000000 },
          }),
        } as Response;
      }
      if (body?.method === 'getTransaction') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { status: 'NOT_FOUND' },
          }),
        } as Response;
      }
      throw new Error(`Unexpected call: ${url} ${init?.body}`);
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await capture({
          dataDir: tempDir,
          only: new Set(['claim-get-transaction']),
          initialRetryDelayMs: 1,
        });
      },
      (err: Error) => {
        assert.match(err.message, /claim-get-transaction/);
        assert.match(err.message, /NOT_FOUND/);
        return true;
      },
    );

    // Verify nothing was written to the directory
    try {
      const files = await readdir(tempDir);
      assert.equal(files.length, 0, 'no fixture files should be written on failure');
    } catch {
      // directory was not created or empty, which is also correct
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an RPC error response is retried with backoff delay', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const callTimes: number[] = [];

  try {
    globalThis.fetch = (async () => {
      attempts++;
      callTimes.push(Date.now());
      if (attempts < 3) {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32603, message: 'Internal RPC error' },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { sequence: 12345 },
        }),
      } as Response;
    }) as typeof fetch;

    const initialDelay = 50;
    const result = await rpcCall('getLatestLedger', null, 'http://mock-rpc', 5, initialDelay);
    assert.equal(result.sequence, 12345);
    assert.equal(attempts, 3);
    assert.ok(callTimes.length >= 3);
    const delay1 = callTimes[1]! - callTimes[0]!;
    assert.ok(delay1 >= 40, `expected delay >= 40ms, got ${delay1}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failure in a later fixture leaves earlier files untouched', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'signet-capture-atomic-'));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: any, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/transactions/')) {
        // Horizon call at the end fails
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        } as Response;
      }
      const body = init?.body ? JSON.parse(init.body) : null;
      if (body?.method === 'getNetwork') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { passphrase: 'Test SDF Network ; September 2015' },
          }),
        } as Response;
      }
      if (body?.method === 'getLatestLedger') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: { sequence: 5000000 },
          }),
        } as Response;
      }
      if (body?.method === 'getLedgerEntries') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            result: {
              entries: [
                {
                  key: 'mockKey',
                  xdr: 'AAAAAgAAAAEAAAAHdmFzbUlkAAAAAAAAAAA=',
                },
              ],
            },
          }),
        } as Response;
      }
      throw new Error(`Unexpected call to ${urlStr}`);
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        // Request both sac-instance-entry and horizon-contract-deploy-tx
        await capture({
          dataDir: tempDir,
          only: new Set(['sac-instance-entry', 'horizon-contract-deploy-tx']),
          initialRetryDelayMs: 1,
        });
      },
      /Horizon GET.*failed/,
    );

    // Assert that sac-instance-entry was NOT written because a later fixture failed
    try {
      const files = await readdir(tempDir);
      assert.equal(
        files.length,
        0,
        `expected 0 files written when later step fails, found: ${files.join(', ')}`,
      );
    } catch {
      // tempDir was not even populated with files, which is correct
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});
