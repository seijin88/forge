// Packfile reading and writing (pack-format). Reading resolves OFS_DELTA and REF_DELTA into full
// objects; writing always emits undeltified objects (a valid pack, and simple to get right).

import { inflateZlibAt, mustInflateZlibAt } from './inflate.ts';
import { OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, ObjectStore, typeName } from './objects.ts';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PACK_SIGNATURE = 0x5041434b; // 'PACK'

/** One object as it came out of a pack (deltas already applied). */
export interface PackedObject {
  type: number;
  content: Buffer;
}

/** Parse a v2 packfile; every object's type/content resolved. Throws on malformed input. */
export function parsePack(buf: Buffer, existing: ObjectStore | null): PackedObject[] {
  if (buf.length < 32) throw new Error('pack shorter than its header+trailer');
  if (buf.readUInt32BE(0) !== PACK_SIGNATURE) throw new Error('pack signature mismatch');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const raw: Array<{ start: number; type: number; data: Buffer | null; baseRef: string | null; baseOffset: number }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length) throw new Error('pack truncated in object headers');
    const start = off; // the object header's own offset: what OFS_DELTA offsets are relative to
    let byte = buf[off++]!;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6) {
      // OFS_DELTA: negative offset to the base, big-endian with +1 per continuation.
      let b = buf[off++]!;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++]!;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const res = mustInflateZlibAt(buf, off, size);
      off += res.consumed;
      raw.push({ start, type, data: res.data, baseRef: null, baseOffset: start - baseOffset });
    } else if (type === 7) {
      const baseRef = buf.toString('hex', off, off + 20);
      off += 20;
      const res = mustInflateZlibAt(buf, off, size);
      off += res.consumed;
      raw.push({ start, type, data: res.data, baseRef, baseOffset: -1 });
    } else if (type >= 1 && type <= 4) {
      const res = mustInflateZlibAt(buf, off, size);
      off += res.consumed;
      raw.push({ start, type, data: res.data, baseRef: null, baseOffset: -1 });
    } else {
      throw new Error(`bad object type ${type} in pack at offset ${start}`);
    }
  }
  // The objects array is offset-ordered by construction, so OFS_DELTA bases precede their users.
  const resolved = new Map<number, PackedObject>();
  const objects: PackedObject[] = [];
  for (const entry of raw) {
    let type = entry.type;
    let content = entry.data;
    if (content === null) throw new Error('unreachable');
    if (type === 6 || type === 7) {
      let base: PackedObject | null = null;
      if (type === 6) {
        base = resolved.get(entry.baseOffset) ?? null;
      } else {
        const known = existing?.get(entry.baseRef!) ?? null;
        if (known !== null) base = { type: known.type, content: known.content };
        else {
          // The base may be an earlier object of this same pack: find it by sha.
          for (const prior of resolved.values()) {
            if (objectShaOf(prior) === entry.baseRef) { base = prior; break; }
          }
        }
      }
      if (base === null) throw new Error(`delta base not found (${type === 6 ? 'ofs' : 'ref'})`);
      content = applyDelta(base.content, content);
      type = base.type;
    }
    const packed: PackedObject = { type, content };
    resolved.set(entry.start, packed);
    objects.push(packed);
  }
  return objects;

  function objectShaOf(obj: PackedObject): string {
    const hash = createHash('sha1');
    hash.update(Buffer.from(`${typeName(obj.type)} ${obj.content.length}\0`, 'ascii'));
    hash.update(obj.content);
    return hash.digest('hex');
  }
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0x80;
    while (byte & 0x80) {
      byte = delta[off++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size mismatch: ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let outOff = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      // Copy from base: offset and size encoded by set bits.
      let copyOff = 0;
      let copySize = 0;
      if (op & 0x01) copyOff |= delta[off++]!;
      if (op & 0x02) copyOff |= delta[off++]! << 8;
      if (op & 0x04) copyOff |= delta[off++]! << 16;
      if (op & 0x08) copyOff |= delta[off++]! << 24;
      if (op & 0x10) copySize |= delta[off++]!;
      if (op & 0x20) copySize |= delta[off++]! << 8;
      if (op & 0x40) copySize |= delta[off++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length || outOff + copySize > resultSize) throw new Error('delta copy out of range');
      base.copy(out, outOff, copyOff, copyOff + copySize);
      outOff += copySize;
    } else if (op > 0) {
      if (off + op > delta.length || outOff + op > resultSize) throw new Error('delta insert out of range');
      delta.copy(out, outOff, off, off + op);
      off += op;
      outOff += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outOff !== resultSize) throw new Error(`delta result size mismatch: ${outOff} != ${resultSize}`);
  return out;
}

/**
 * Build a v2 packfile holding the given objects, undeltified. `entries` are {type, content};
 * the caller sorts (order is irrelevant to correctness).
 */
export function buildPack(entries: ReadonlyArray<PackedObject>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const entry of entries) {
    // Size header: type in bits 6-4, low 4 bits of size, then 7-bit continuation groups.
    let size = entry.content.length;
    let byte = (entry.type << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    while (size > 0) {
      headBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(byte);
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(entry.content, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Small helper the store uses to keep the public surface tight. */
export const PACK_OBJECT_TYPES = Object.freeze({ commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG });
