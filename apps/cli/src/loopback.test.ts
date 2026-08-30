import { describe, it, expect, afterEach } from 'vitest';
import { createLoopbackServer } from './loopback.js';
import { request } from 'node:http';

describe('loopback server', () => {
  let serverInstance: import('node:http').Server | null = null;
  
  afterEach(() => {
    if (serverInstance) {
      serverInstance.close();
      serverInstance = null;
    }
  });

  const sendGet = (port: number, path: string): Promise<{ statusCode: number | undefined; body: string }> => {
    return new Promise((resolve, reject) => {
      const req = request(`http://localhost:${port}${path}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
  };

  it('rejects callback with invalid state without terminating', async () => {
    const { port, server, tokenPromise } = await createLoopbackServer('expected-state-123');
    serverInstance = server;
    
    // 1. Send invalid state
    const res1 = await sendGet(port, '/callback?state=wrong-state&token=abc&handle=foo');
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toContain('Invalid state parameter');
    
    // The server should still be listening! Let's send a valid one now.
    const res2 = await sendGet(port, '/callback?state=expected-state-123&token=good-token&handle=good-handle');
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toContain('Approved!');
    
    const result = await tokenPromise;
    expect(result).toEqual({ token: 'good-token', handle: 'good-handle' });
  });
});
