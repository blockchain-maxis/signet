import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ALLOWED_METHODS,
  handlePreflight,
  isAllowedOrigin,
  responseHeaders,
} from './loopback-cors.ts';

/**
 * Single-use loopback callback server for `signet link`.
 *
 * The CLI opens the approval page in the browser and waits here for the page
 * to POST the result back. The server binds `127.0.0.1` explicitly rather than
 * `0.0.0.0` — nothing outside this machine should be able to reach a pairing
 * callback — accepts exactly one successful callback, and then closes.
 */

export interface LoopbackResult {
  /** JSON body the approval page posted. */
  payload: unknown;
}

export interface LoopbackServerOptions {
  /** The deployment origin the approval page is served from, e.g. `https://signet.dev`. */
  deploymentOrigin: string;
  /** Port to bind. 0 (default) picks a free one. */
  port?: number;
  /** How long to wait for the callback before giving up. */
  timeoutMs?: number;
  /** Optional sink for refusals, so the CLI can print them. */
  onRefusal?: (message: string) => void;
}

export class LoopbackTimeoutError extends Error {
  constructor(ms: number) {
    super(`no callback received within ${ms}ms`);
    this.name = 'LoopbackTimeoutError';
  }
}

const MAX_BODY_BYTES = 64 * 1024;

export interface LoopbackHandle {
  /** `http://127.0.0.1:<port>` — the redirect target to hand the approval page. */
  readonly url: string;
  /** Resolves with the single callback, or rejects on timeout. */
  readonly result: Promise<LoopbackResult>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    // A callback payload is small. An unbounded read on a server that any
    // local process can reach is a free way to exhaust the CLI's memory.
    if (size > MAX_BODY_BYTES) throw new Error('callback body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackHandle> {
  const { deploymentOrigin, port = 0, timeoutMs = 5 * 60_000, onRefusal } = options;

  let settle: (result: LoopbackResult) => void;
  let fail: (err: Error) => void;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const refuse = (res: ServerResponse, status: number, message: string) => {
    onRefusal?.(message);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const headers = req.headers as Record<string, string | string[] | undefined>;

      // The preflight. Chrome sends this for public -> private even though the
      // request itself would otherwise be simple, and refuses the real request
      // unless this server opts in.
      if (req.method === 'OPTIONS') {
        const decision = handlePreflight(headers, deploymentOrigin);
        if (decision.refusal) onRefusal?.(decision.refusal);
        res.writeHead(decision.status, decision.headers);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: ALLOWED_METHODS });
        res.end();
        return;
      }

      const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
      if (!isAllowedOrigin(origin, deploymentOrigin)) {
        // Checked again on the real request: a preflight is a browser
        // courtesy, not a security boundary — anything that is not a browser
        // simply skips it.
        refuse(res, 403, `refused callback from origin ${origin ?? '<none>'}`);
        return;
      }

      let payload: unknown;
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch (err) {
        refuse(res, 400, `invalid callback body: ${(err as Error).message}`);
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        // The real response needs the CORS header too: without it the browser
        // blocks the page from reading the result, and the page cannot tell
        // success from failure.
        ...responseHeaders(headers, deploymentOrigin),
      });
      res.end(JSON.stringify({ ok: true }));

      settle({ payload });
    })();
  });

  const timer = setTimeout(() => fail(new LoopbackTimeoutError(timeoutMs)), timeoutMs);
  // Never hold the process open on the timer alone.
  timer.unref?.();

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // Single-use: the server stops accepting the moment it has its answer.
  void result.then(
    () => void close(),
    () => void close(),
  );

  return new Promise<LoopbackHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        result,
        close,
      });
    });
  });
}
