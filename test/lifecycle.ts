import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createApp } from '../app.ts';
import { runLifecycle } from '../main.ts';
import { installTransport } from './transport.ts';

// The sandbox denies sockets. Exercise the real HTTP handlers and lifecycle,
// substituting only kernel bind/address and the environment's transport.
for (const registeredStatus of [200, 409]) {
  let registered = false, registerAttempts = 0, polls = 0, closed = false;
  const waits: number[] = [];
  const app = createApp();
  const appTransport = installTransport(app);
  const appFetch = appTransport.fetch;
  app.listen = ((port: number, host: string, callback: () => void) => {
    assert.equal(port, 0); assert.equal(host, '0.0.0.0');
    queueMicrotask(callback); return app;
  }) as Server['listen'];
  app.address = () => ({ address: '0.0.0.0', family: 'IPv4', port: 34567 });
  app.close = ((callback: () => void) => { assert.ok(registered && polls === 4); closed = true; queueMicrotask(callback); return app; }) as Server['close'];
  const env = createServer(async (req, res) => {
    assert.equal(closed, false);
    if (req.url === '/register') {
      registerAttempts++;
      assert.equal(req.method, 'POST');
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { port: 34567 });
      assert.equal((await appFetch('http://app.local:34567/healthz')).status, 200);
      if (registerAttempts === 1) { res.writeHead(503); res.end('{}'); return; }
      registered = true; res.writeHead(registeredStatus); res.end('{}'); return;
    }
    assert.equal(req.url, '/done'); assert.equal(req.method, 'GET'); assert.ok(registered);
    polls++;
    // A malformed poll, false, and a temporary failure must all keep it alive.
    if (polls === 1) { res.end('{'); return; }
    if (polls === 3) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ done: polls === 4 }));
  });
  const envTransport = installTransport(env);
  await runLifecycle({ envUrl: 'http://env.local:34567/', server: app, fetchImpl: envTransport.fetch, sleepImpl: async ms => { waits.push(ms); } });
  assert.ok(closed); assert.equal(registerAttempts, 2); assert.equal(polls, 4);
  assert.deepEqual(waits, [250, 250, 500, 1000]);
  // Restore the real close so disposing this unbound test server is harmless.
  app.close = Object.getPrototypeOf(app).close;
  appTransport.close(); envTransport.close();
}
await assert.rejects(runLifecycle({ envUrl: '' }), /MAKEFUN_ENV_URL/);
console.log('Lifecycle passed: ephemeral binding, registration retry/409, polling retry, done-only shutdown, missing env.');
