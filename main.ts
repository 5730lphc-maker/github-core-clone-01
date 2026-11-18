// Standalone entrypoint. The trial's environment is the only outbound service.
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const retryDelay = (attempt: number): number => Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));

interface LifecycleOptions {
  envUrl?: string;
  server?: Server;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Bind port 0, register it, poll /done, and drain only after done:true. */
export async function runLifecycle(options: LifecycleOptions = {}): Promise<void> {
  const envUrl = (options.envUrl ?? process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!envUrl) throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  const server = options.server ?? createApp();
  const request = options.fetchImpl ?? fetch;
  const wait = options.sleepImpl ?? sleep;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.port === 8080) throw new Error('The server did not bind an allowed ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(`${envUrl}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: address.port }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Consume the register response before reusing its keep-alive connection.
      const text = await response.text();
      if (response.status === 200 || response.status === 409) break;
      if (response.status === 400 || response.status === 405) throw new Error(`register answered HTTP ${response.status}: ${text}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await wait(retryDelay(attempt));
  }
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok && (await response.json() as { done?: unknown }).done === true) break;
    } catch { /* A failed poll is retried; only done:true ends the trial. */ }
    await wait(retryDelay(attempt));
  }
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  process.stdout.write('[entry] done\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runLifecycle(); process.exit(0); }
  catch (error) {
    process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
