import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError, Store, type Json } from './store.ts';
import { rest } from './rest.ts';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createApp() {
  const store = new Store(); let requests = 0;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('X-GitHub-Request-Id', (++requests).toString(16).padStart(12, '0'));
    try {
      const url = new URL(req.url || '/', 'http://entry');
      const method = req.method || 'GET', path = url.pathname;
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (!process.env.MAKEFUN_SHOP_TOKEN || req.headers.authorization !== `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`) {
        sendJson(res, 401, { message: 'Bad credentials' }); return;
      }
      store.origin = `http://${req.headers.host || 'entry'}`;
      let body: Json = {};
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(req);
        if (raw.length) {
          try { body = JSON.parse(raw.toString()); }
          catch { throw new ApiError(400, 'Invalid JSON'); }
        }
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const result = rest(store, method, path.slice(7) || '/', url, body);
        sendJson(res, result.status, result.body, result.headers); return;
      }
      throw new ApiError(404, 'Not Found');
    } catch (err) {
      if (!(err instanceof ApiError)) process.stderr.write(`[request] ${err instanceof Error ? err.stack : err}\n`);
      if (!res.headersSent) sendJson(res, err instanceof ApiError ? err.status : 500, { message: err instanceof ApiError ? err.message : 'Internal Server Error' });
      else res.end();
    }
  });
}
