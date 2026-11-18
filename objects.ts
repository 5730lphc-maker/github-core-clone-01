import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjectKind; data: Buffer; packed?: Buffer }
export interface TreeEntry { mode: string; name: string; oid: string }
export const ZERO = '0'.repeat(40);
const kinds = ['', 'commit', 'tree', 'blob', 'tag'] as const;
export const sha1 = (data: Buffer): Buffer => createHash('sha1').update(data).digest();
export function objectId(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

export class Objects {
  all = new Map<string, GitObject>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  trees = new Map<string, TreeEntry[]>();
  put(type: ObjectKind, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.all.has(oid)) this.all.set(oid, { type, data });
    return oid;
  }
  commit(oid: string) {
    let value = this.commits.get(oid);
    if (!value) {
      const obj = this.all.get(oid);
      if (obj?.type !== 'commit') throw new Error('Missing commit');
      const text = obj.data.toString();
      const split = text.indexOf('\n\n');
      const headers = text.slice(0, split).split('\n');
      value = { tree: headers.find(s => s.startsWith('tree '))!.slice(5), parents: headers.filter(s => s.startsWith('parent ')).map(s => s.slice(7)), message: text.slice(split + 2).replace(/\n$/, '') };
      this.commits.set(oid, value);
    }
    return value;
  }
  tree(oid: string): TreeEntry[] {
    let entries = this.trees.get(oid);
    if (!entries) {
      const obj = this.all.get(oid);
      if (obj?.type !== 'tree') throw new Error('Missing tree');
      entries = [];
      for (let p = 0; p < obj.data.length;) {
        const space = obj.data.indexOf(32, p), nul = obj.data.indexOf(0, space);
        if (space < p || nul < space || nul + 21 > obj.data.length) throw new Error('Invalid tree');
        entries.push({ mode: obj.data.toString('utf8', p, space), name: obj.data.toString('utf8', space + 1, nul), oid: obj.data.subarray(nul + 1, nul + 21).toString('hex') });
        p = nul + 21;
      }
      this.trees.set(oid, entries);
    }
    return entries;
  }
  buildTree(files: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [], dirs = new Set<string>();
      for (const [path, entry] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) entries.push({ ...entry, name: rest });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) entries.push({ name: dir, mode: '40000', oid: build(`${prefix}${dir}/`) });
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.put('tree', Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')])));
    };
    return build('');
  }
  files(commit: string | undefined): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    if (!commit) return files;
    const walk = (oid: string, prefix: string) => {
      for (const entry of this.tree(oid)) {
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
        else files.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(this.commit(commit).tree, '');
    return files;
  }
  createCommit(tree: string, parents: string[], message: string, timestamp: number): string {
    const identity = `Forge <forge@localhost> ${timestamp} +0000`;
    return this.put('commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message}\n`));
  }
  peel(oid: string): string {
    const seen = new Set<string>();
    while (this.all.get(oid)?.type === 'tag' && !seen.has(oid)) {
      seen.add(oid);
      oid = /^object ([0-9a-f]{40})/m.exec(this.all.get(oid)!.data.toString())?.[1] ?? oid;
    }
    return oid;
  }
  ancestor(old: string, tip: string): boolean {
    const pending = [tip], seen = new Set<string>();
    while (pending.length) {
      const oid = pending.pop()!;
      if (oid === old) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (this.all.get(oid)?.type === 'commit') pending.push(...this.commit(oid).parents);
    }
    return false;
  }
  reachable(tips: string[], depth = Infinity, boundaries = new Set<string>()): Set<string> {
    const found = new Set<string>(), best = new Map<string, number>();
    const walk = (oid: string, level: number) => {
      const obj = this.all.get(oid);
      if (!obj) throw new Error(`Missing object ${oid}`);
      if (found.has(oid) && (best.get(oid) ?? Infinity) <= level) return;
      found.add(oid); best.set(oid, level);
      if (obj.type === 'commit') {
        const commit = this.commit(oid);
        walk(commit.tree, 0);
        if (level < depth && !boundaries.has(oid)) for (const parent of commit.parents) walk(parent, level + 1);
      } else if (obj.type === 'tree') {
        for (const entry of this.tree(oid)) if (entry.mode !== '160000') walk(entry.oid, 0);
      } else if (obj.type === 'tag') walk(this.peel(oid), level);
    };
    for (const oid of tips) walk(oid, 1);
    return found;
  }
  pack(ids: Iterable<string>): Buffer {
    const parts: Buffer[] = [], header = Buffer.alloc(12);
    let count = 0;
    for (const oid of ids) {
      const obj = this.all.get(oid)!;
      if (!obj.packed) {
        let size = obj.data.length;
        const bytes = [(kinds.indexOf(obj.type) << 4) | (size & 15)];
        size = Math.floor(size / 16);
        while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size = Math.floor(size / 128); }
        obj.packed = Buffer.concat([Buffer.from(bytes), deflateSync(obj.data, { level: 1 })]);
      }
      parts.push(obj.packed); count++;
    }
    header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
    const payload = Buffer.concat([header, ...parts]);
    return Buffer.concat([payload, sha1(payload)]);
  }
  readPack(pack: Buffer): Map<string, GitObject> {
    if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
    if (!sha1(pack.subarray(0, -20)).equals(pack.subarray(-20))) throw new Error('Invalid pack checksum');
    let p = 12;
    const offsets = new Map<number, { oid: string; obj: GitObject }>();
    const incoming = new Map<string, GitObject>();
    const delayed: { offset: number; base: string | number; delta: Buffer }[] = [];
    const add = (offset: number, obj: GitObject) => {
      const oid = objectId(obj.type, obj.data); incoming.set(oid, obj); offsets.set(offset, { oid, obj });
    };
    for (let i = 0, count = pack.readUInt32BE(8); i < count; i++) {
      const offset = p;
      let byte = pack[p++], size = byte & 15, shift = 4;
      const kind = (byte >> 4) & 7;
      while (byte & 128) { byte = pack[p++]; size += (byte & 127) * 2 ** shift; shift += 7; if (shift > 53) throw new Error('Oversized object'); }
      let base: string | number | undefined;
      if (kind === 6) {
        byte = pack[p++]; let distance = byte & 127;
        while (byte & 128) { byte = pack[p++]; distance = (distance + 1) * 128 + (byte & 127); }
        base = offset - distance;
      } else if (kind === 7) { base = pack.subarray(p, p + 20).toString('hex'); p += 20; }
      const inflated = inflateSync(pack.subarray(p, -20), { info: true, maxOutputLength: 64 * 1024 * 1024 });
      p += inflated.engine.bytesWritten;
      if (inflated.buffer.length !== size) throw new Error('Object size mismatch');
      if (base !== undefined) delayed.push({ offset, base, delta: inflated.buffer });
      else {
        const type = kinds[kind]; if (!type) throw new Error('Unknown object type');
        add(offset, { type, data: inflated.buffer });
      }
    }
    if (p !== pack.length - 20) throw new Error('Trailing pack data');
    while (delayed.length) {
      let progress = false;
      for (let i = delayed.length - 1; i >= 0; i--) {
        const item = delayed[i];
        const base = typeof item.base === 'number' ? offsets.get(item.base)?.obj : incoming.get(item.base) ?? this.all.get(item.base);
        if (!base) continue;
        add(item.offset, { type: base.type, data: applyDelta(base.data, item.delta) });
        delayed.splice(i, 1); progress = true;
      }
      if (!progress) throw new Error('Missing delta base');
    }
    return incoming;
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readInt = () => { let n = 0, shift = 0, b: number; do { b = delta[p++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return n; };
  if (readInt() !== base.length) throw new Error('Delta base size mismatch');
  const target = readInt();
  if (target > 64 * 1024 * 1024) throw new Error('Delta too large');
  const output = Buffer.alloc(target); let out = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 128) {
      let offset = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[p++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) size += delta[p++] * 2 ** (8 * i);
      if (!size) size = 65536;
      if (offset + size > base.length || out + size > target) throw new Error('Invalid delta copy');
      base.copy(output, out, offset, offset + size); out += size;
    } else {
      if (!op || p + op > delta.length || out + op > target) throw new Error('Invalid delta insert');
      delta.copy(output, out, p, p + op); p += op; out += op;
    }
  }
  if (out !== target) throw new Error('Delta result size mismatch');
  return output;
}
