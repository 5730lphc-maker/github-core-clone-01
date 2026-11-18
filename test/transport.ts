// Socket-free local transport: actual Node HTTP parsers on paired Duplex streams.
// Only used by local validation; the forge's production server is unchanged.
import http, { type Server } from 'node:http';
import { Duplex } from 'node:stream';
class MemorySocket extends Duplex {
  peer!: MemorySocket;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 34567;
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) { this.peer.push(Buffer.from(chunk)); callback(); }
  _final(callback: () => void) { this.peer.push(null); callback(); }
  setTimeout(_ms: number, _callback?: () => void) { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  destroySoon() { this.end(); }
}
export function installTransport(server: Server) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
  agent.createConnection = () => {
    const client = new MemorySocket(), remote = new MemorySocket();
    client.peer = remote; remote.peer = client;
    server.emit('connection', remote);
    return client as any;
  };
  const fetchLocal: typeof fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(init.headers ?? request?.headers);
    const body = init.body ?? (request ? await request.arrayBuffer() : undefined);
    const bytes = body == null ? undefined : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);
    if (bytes) headers.set('content-length', String(bytes.length));
    return new Promise<Response>((resolve, reject) => {
      const req = http.request(url, { method: init.method ?? request?.method ?? 'GET', headers: Object.fromEntries(headers), agent, signal: init.signal ?? undefined }, res => {
        const parts: Buffer[] = [];
        res.on('data', b => parts.push(b)); res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve(new Response([204, 205, 304].includes(res.statusCode!) ? null : Buffer.concat(parts), { status: res.statusCode, headers }));
        });
      });
      req.on('error', reject); req.end(bytes);
    });
  };
  globalThis.fetch = fetchLocal;
  return { agent, close() { agent.destroy(); server.close(); } };
}
