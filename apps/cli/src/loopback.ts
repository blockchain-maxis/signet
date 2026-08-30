import { createServer, Server } from 'node:http';

export function createLoopbackServer(expectedState: string): Promise<{
  port: number;
  server: Server;
  tokenPromise: Promise<{ token: string; handle: string }>;
}> {
  return new Promise((resolve) => {
    const server = createServer();
    
    const tokenPromise = new Promise<{ token: string; handle: string }>((resolvePromise, rejectPromise) => {
      server.on('request', (req, res) => {
        try {
          const url = new URL(req.url || '', `http://localhost:${(server.address() as any).port}`);
          if (url.pathname === '/callback') {
            const callbackState = url.searchParams.get('state');
            
            if (callbackState !== expectedState) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>Error</h1><p>Invalid state parameter. This could be a CSRF attack.</p></body></html>');
              return;
            }
            
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

    server.listen(0, () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({ port, server, tokenPromise });
    });
  });
}
