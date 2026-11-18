import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Objects, objectId, sha1 } from '../objects.ts';

const base = Buffer.from('hello world\n'), target = Buffer.from('hello forge\n');
// Copy the shared prefix, insert the changed suffix.
const delta = Buffer.concat([Buffer.from([base.length, target.length, 0x90, 6, 6]), Buffer.from('forge\n')]);
const entry = (kind: number, data: Buffer, reference = Buffer.alloc(0)): Buffer => {
  let size = data.length;
  const head = [(kind << 4) | (size & 15)]; size >>>= 4;
  while (size) { head[head.length - 1] |= 128; head.push(size & 127); size >>>= 7; }
  return Buffer.concat([Buffer.from(head), reference, deflateSync(data)]);
};
const pack = (...entries: Buffer[]) => {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(entries.length, 8);
  const payload = Buffer.concat([header, ...entries]); return Buffer.concat([payload, sha1(payload)]);
};
const expected = objectId('blob', target), baseId = objectId('blob', base);
const baseEntry = entry(3, base);
assert.ok(baseEntry.length < 128);
const store = new Objects();
// OFS_DELTA, forward REF_DELTA and a thin pack whose base already exists.
const ofs = store.readPack(pack(baseEntry, entry(6, delta, Buffer.from([baseEntry.length]))));
assert.deepEqual(ofs.get(expected)?.data, target);
const forward = store.readPack(pack(entry(7, delta, Buffer.from(baseId, 'hex')), baseEntry));
assert.deepEqual(forward.get(expected)?.data, target);
store.put('blob', base);
assert.deepEqual(store.readPack(pack(entry(7, delta, Buffer.from(baseId, 'hex')))).get(expected)?.data, target);
const broken = pack(baseEntry); broken[15] ^= 1;
assert.throws(() => store.readPack(broken), /checksum/);
assert.throws(() => new Objects().readPack(pack(entry(7, delta, Buffer.from(baseId, 'hex')))), /delta base/);
const invalidDelta = Buffer.from([base.length, 1, 0x91, 100, 1]);
assert.throws(() => store.readPack(pack(entry(7, invalidDelta, Buffer.from(baseId, 'hex')))), /delta copy/);
// Native object generation must preserve byte order, modes and binary blobs.
const binary = store.put('blob', Buffer.from([0, 255, 1, 0, 128]));
const tree = store.buildTree(new Map([['src/file.bin', { oid: binary, mode: '100755' }], ['src.txt', { oid: baseId, mode: '100644' }]]));
const commit = store.createCommit(tree, [], 'Binary commit', 1700000000);
assert.equal(store.files(commit).get('src/file.bin')?.mode, '100755');
const reachable = store.reachable([commit]);
assert.equal(store.readPack(store.pack(reachable)).size, reachable.size);
console.log('Object tests passed: OFS/REF/forward/thin deltas, invalid packs, binary trees, pack round trip.');
