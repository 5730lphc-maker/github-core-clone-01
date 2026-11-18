import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, Store, type Repository } from './store.ts';
import { ZERO } from './objects.ts';

const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  if (payload.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0')), payload]);
}
function parsePackets(data: Buffer, stopAtFlush = false): { lines: string[]; offset: number } {
  const lines: string[] = []; let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length || !/^[a-f\d]{4}$/i.test(data.toString('ascii', offset, offset + 4))) throw new ApiError(400, 'Invalid pkt-line');
    const n = parseInt(data.toString('ascii', offset, offset + 4), 16); offset += 4;
    if (n === 0) { if (stopAtFlush) break; continue; }
    if (n === 1 || n === 2) continue;
    if (n < 4 || n > 65520 || offset + n - 4 > data.length) throw new ApiError(400, 'Invalid pkt-line length');
    lines.push(data.toString('utf8', offset, offset + n - 4).replace(/\n$/, '')); offset += n - 4;
  }
  return { lines, offset };
}
function sideband(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65000) parts.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + 65000)])));
  return parts;
}
function refList(repo: Repository): [string, string][] {
  const refs = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
  const head = repo.refs.get(`refs/heads/${repo.data.default_branch}`);
  if (head) refs.unshift(['HEAD', head]);
  return refs;
}
function advertise(repo: Repository, service: string, v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') return Buffer.concat([
    pkt('version 2\n'), pkt('agent=standalone-forge/1\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('object-format=sha1\n'), FLUSH,
  ]);
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=standalone-forge/1'
    : `multi_ack_detailed side-band-64k shallow ofs-delta include-tag symref=HEAD:refs/heads/${repo.data.default_branch} agent=standalone-forge/1`;
  const parts = [pkt(`# service=${service}\n`), FLUSH];
  const refs = refList(repo);
  if (!refs.length) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  for (let i = 0; i < refs.length; i++) {
    const [name, oid] = refs[i];
    parts.push(pkt(`${oid} ${name}${i ? '' : '\0' + caps}\n`));
    if (name.startsWith('refs/tags/') && repo.objects.all.get(oid)?.type === 'tag') parts.push(pkt(`${repo.objects.peel(oid)} ${name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function lsRefs(repo: Repository, lines: string[]): Buffer {
  const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11));
  const keep = (ref: string) => !prefixes.length || prefixes.some(p => ref.startsWith(p));
  const parts: Buffer[] = [];
  for (const [name, oid] of refList(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (name === 'HEAD' && lines.includes('symrefs')) line += ` symref-target:refs/heads/${repo.data.default_branch}`;
    if (lines.includes('peel') && repo.objects.all.get(oid)?.type === 'tag') line += ` peeled:${repo.objects.peel(oid)}`;
    parts.push(pkt(line + '\n'));
  }
  if (!repo.refs.size && lines.includes('unborn') && keep('HEAD')) parts.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.data.default_branch}\n`));
  return Buffer.concat([...parts, FLUSH]);
}
function upload(repo: Repository, raw: Buffer, v2: boolean): Buffer {
  const { lines } = parsePackets(raw);
  if (v2 && lines.includes('command=ls-refs')) return lsRefs(repo, lines);
  if (v2 && !lines.includes('command=fetch')) throw new ApiError(400, 'Unknown git command');
  const values = (prefix: string) => lines.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length).split(' ')[0]);
  const wants = values('want '), haves = values('have '), shallow = new Set(values('shallow '));
  if (!wants.length || [...wants, ...haves, ...shallow].some(s => !/^[0-9a-f]{40}$/.test(s))) throw new ApiError(400, 'Invalid wants or haves');
  if (wants.some(w => !repo.objects.all.has(w))) throw new ApiError(400, 'Unknown wanted object');
  const depthValue = values('deepen ')[0], depth = depthValue ? Number(depthValue) : Infinity;
  if (depth <= 0 || Number.isNaN(depth)) throw new ApiError(400, 'Invalid depth');
  const key = JSON.stringify([v2, wants, haves, [...shallow], depthValue]);
  const cached = repo.packs.get(key); if (cached) return cached;
  const omit = repo.objects.reachable(haves.filter(h => repo.objects.all.has(h)), Infinity, shallow);
  const wanted = repo.objects.reachable(wants, depth);
  for (const oid of omit) wanted.delete(oid);
  const boundaries = new Set<string>(), visited = new Map<string, number>();
  const walk = (oid: string, level: number) => {
    oid = repo.objects.peel(oid);
    if (repo.objects.all.get(oid)?.type !== 'commit' || (visited.get(oid) ?? Infinity) <= level) return;
    visited.set(oid, level);
    const parents = repo.objects.commit(oid).parents;
    if (level >= depth) { if (parents.length) boundaries.add(oid); }
    else for (const parent of parents) walk(parent, level + 1);
  };
  if (depth !== Infinity) for (const want of wants) walk(want, 1);
  // A commit reached along a shorter path is not a boundary on that path.
  for (const oid of boundaries) if (visited.get(oid)! < depth) boundaries.delete(oid);
  const unshallow = [...shallow].filter(oid => visited.has(oid) && !boundaries.has(oid));
  const parts: Buffer[] = [];
  if (v2) {
    if (boundaries.size || unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of boundaries) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    parts.push(pkt('packfile\n'));
  } else {
    for (const oid of boundaries) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    if (depthValue) parts.push(FLUSH);
    parts.push(pkt('NAK\n'));
  }
  parts.push(...sideband(repo.objects.pack(wanted)), FLUSH);
  const response = Buffer.concat(parts);
  if (repo.packs.size >= 64) repo.packs.delete(repo.packs.keys().next().value!);
  repo.packs.set(key, response);
  return response;
}
function receive(repo: Repository, raw: Buffer): Buffer {
  const { lines, offset } = parsePackets(raw, true);
  if (!lines.length) throw new ApiError(400, 'Missing receive commands');
  const caps = lines[0].split('\0')[1] || '';
  const commands = lines.map(line => {
    const match = /^([a-f\d]{40}) ([a-f\d]{40}) (refs\/[^\s\0]+)(?:\0.*)?$/.exec(line);
    if (!match || /\.\.|[~^:?*\[\\]/.test(match[3]) || match[3].endsWith('/')) throw new ApiError(400, 'Invalid ref command');
    return { old: match[1], tip: match[2], ref: match[3] };
  });
  let unpack = 'ok';
  try {
    if (offset < raw.length) {
      const incoming = repo.objects.readPack(raw.subarray(offset));
      for (const [oid, obj] of incoming) if (!repo.objects.all.has(oid)) repo.objects.all.set(oid, obj);
    } else if (commands.some(c => c.tip !== ZERO)) throw new Error('Missing pack');
  } catch (err) { unpack = err instanceof Error ? err.message : 'Invalid pack'; }
  const reports = [pkt(`unpack ${unpack}\n`)];
  for (const command of commands) {
    let reason = unpack !== 'ok' ? 'unpacker error' : '';
    const current = repo.refs.get(command.ref) || ZERO;
    if (!reason && current !== command.old) reason = 'stale info';
    if (!reason && command.tip !== ZERO) {
      if (!repo.objects.all.has(command.tip)) reason = 'missing object';
      else if (command.ref.startsWith('refs/heads/') && repo.objects.all.get(command.tip)?.type !== 'commit') reason = 'not a commit';
      else if (command.old !== ZERO && !repo.objects.ancestor(command.old, command.tip)) reason = 'non-fast-forward';
      if (!reason) {
        try { repo.objects.reachable([command.tip]); } catch { reason = 'missing objects'; }
      }
    }
    if (reason) reports.push(pkt(`ng ${command.ref} ${reason}\n`));
    else {
      if (command.tip === ZERO) repo.refs.delete(command.ref); else repo.refs.set(command.ref, command.tip);
      reports.push(pkt(`ok ${command.ref}\n`)); repo.packs.clear();
    }
  }
  reports.push(FLUSH);
  const report = Buffer.concat(reports);
  return caps.split(' ').includes('side-band-64k') ? Buffer.concat([...sideband(report), FLUSH]) : report;
}

export function gitHttp(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return false;
  const repo = store.repo(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  const route = match[3], v2 = String(req.headers['git-protocol'] || '').includes('version=2');
  let service: string, body: Buffer;
  if (route === 'info/refs' && req.method === 'GET') {
    service = url.searchParams.get('service') || '';
    if (!['git-upload-pack', 'git-receive-pack'].includes(service)) throw new ApiError(400, 'Invalid service');
    body = advertise(repo, service, v2);
  } else if (req.method === 'POST' && route !== 'info/refs') {
    service = route;
    body = service === 'git-upload-pack' ? upload(repo, raw, v2) : receive(repo, raw);
  } else throw new ApiError(404, 'Not Found');
  res.writeHead(200, { 'content-type': `application/x-${service}-${route === 'info/refs' ? 'advertisement' : 'result'}`, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body); return true;
}
