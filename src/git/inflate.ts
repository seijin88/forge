// A minimal DEFLATE (RFC 1951) decoder with zlib (RFC 1950) wrapper, written so the exact
// number of input bytes consumed is known: packfiles hold many zlib streams back to back and
// node:zlib's sync helpers cannot say where one stream ends. Only the decode side is custom;
// encoding stays on node:zlib (deflateSync), which is the performance-critical direction.
//
// The decoder below is the fallback: node:zlib's inflateSync reports the bytes it consumed when
// it is called with the `info` option, so the fast path uses zlib and this code only runs for
// streams zlib refuses.

import { inflateSync } from 'node:zlib';

export interface InflateResult {
  data: Buffer;
  /** Bytes of `input` consumed from `offset`, zlib header and adler included. */
  consumed: number;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman decoder built from code lengths (RFC 1951 §3.2.2). */
class Huffman {
  /** counts[n] = how many codes of length n; symbols in canonical order. */
  private readonly counts: Int32Array;
  private readonly symbols: Int32Array;

  constructor(lengths: ReadonlyArray<number>) {
    const counts = new Int32Array(16);
    for (const len of lengths) counts[len]! += 1;
    counts[0] = 0;
    const offsets = new Int32Array(16);
    for (let i = 1; i < 16; i += 1) offsets[i] = offsets[i - 1]! + counts[i - 1]!;
    const symbols = new Int32Array(lengths.length);
    for (let sym = 0; sym < lengths.length; sym += 1) {
      if (lengths[sym]! !== 0) symbols[offsets[lengths[sym]!]++] = sym;
    }
    this.counts = counts;
    this.symbols = symbols;
  }

  /** Decode one symbol; -1 when the stream runs out. */
  decode(reader: BitReader): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len += 1) {
      code |= reader.bit();
      const count = this.counts[len]!;
      if (code - first < count) return this.symbols[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  }
}

/** LSB-first bit reader over a byte window. */
class BitReader {
  pos = 0; // byte position
  private bitBuf = 0;
  private bitCnt = 0;
  private readonly input: Buffer;
  private readonly start: number;
  private readonly end: number;

  constructor(input: Buffer, start: number, end: number) {
    this.input = input;
    this.start = start;
    this.end = end;
  }

  /** One bit, or -1 past the end. */
  bit(): number {
    if (this.bitCnt === 0) {
      if (this.pos >= this.end) return -1;
      this.bitBuf = this.input[this.start + this.pos++]!;
      this.bitCnt = 8;
    }
    const bit = this.bitBuf & 1;
    this.bitBuf >>= 1;
    this.bitCnt -= 1;
    return bit;
  }

  /** Up to 16 bits, LSB first; -1 past the end. */
  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const bit = this.bit();
      if (bit < 0) return -1;
      value |= bit << i;
    }
    return value;
  }

  /** Align to the next byte boundary, consuming whole buffered bits. */
  align(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
}

function fixedLiteralLengths(): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < 144; i += 1) lengths.push(8);
  for (let i = 144; i < 256; i += 1) lengths.push(9);
  for (let i = 256; i < 280; i += 1) lengths.push(7);
  for (let i = 280; i < 288; i += 1) lengths.push(8);
  return lengths;
}

const FIXED_LITERALS = new Huffman(fixedLiteralLengths());
const FIXED_DISTANCES = new Huffman(new Array<number>(30).fill(5));

/** Decode one raw DEFLATE stream from `input[start..end)` into a growing output buffer. */
function inflateRaw(reader: BitReader, output: number[]): boolean {
  for (;;) {
    const final = reader.bit();
    const type = reader.bits(2);
    if (final < 0 || type < 0) return false;
    if (type === 0) {
      // Stored: skip to byte boundary, LEN/NLEN, then LEN raw bytes.
      reader.align();
      const pos = reader.pos;
      if (pos + 4 > reader['end']) return false;
      const len = reader['input'][reader['start'] + pos]! | (reader['input'][reader['start'] + pos + 1]! << 8);
      const nlen = reader['input'][reader['start'] + pos + 2]! | (reader['input'][reader['start'] + pos + 3]! << 8);
      if ((len ^ 0xffff) !== nlen) return false;
      reader.pos = pos + 4;
      for (let i = 0; i < len; i += 1) {
        const byte = reader.bits(8);
        if (byte < 0) return false;
        output.push(byte);
      }
    } else {
      let literals: Huffman;
      let distances: Huffman;
      if (type === 1) {
        literals = FIXED_LITERALS;
        distances = FIXED_DISTANCES;
      } else if (type === 2) {
        const hlit = reader.bits(5);
        const hdist = reader.bits(5);
        const hclen = reader.bits(4);
        if (hlit < 0 || hdist < 0 || hclen < 0) return false;
        const codeLengthLengths = new Array<number>(19).fill(0);
        for (let i = 0; i < hclen + 4; i += 1) {
          const bits = reader.bits(3);
          if (bits < 0) return false;
          codeLengthLengths[CODE_LENGTH_ORDER[i]!] = bits;
        }
        const codeLengthHuffman = new Huffman(codeLengthLengths);
        const lengths: number[] = [];
        while (lengths.length < hlit + 257 + hdist + 1) {
          const sym = codeLengthHuffman.decode(reader);
          if (sym < 0) return false;
          if (sym < 16) {
            lengths.push(sym);
          } else if (sym === 16) {
            const prev = lengths[lengths.length - 1];
            if (prev === undefined) return false;
            const repeat = reader.bits(2);
            if (repeat < 0) return false;
            for (let i = 0; i < repeat + 3; i += 1) lengths.push(prev);
          } else if (sym === 17) {
            const repeat = reader.bits(3);
            if (repeat < 0) return false;
            for (let i = 0; i < repeat + 3; i += 1) lengths.push(0);
          } else {
            const repeat = reader.bits(7);
            if (repeat < 0) return false;
            for (let i = 0; i < repeat + 11; i += 1) lengths.push(0);
          }
        }
        literals = new Huffman(lengths.slice(0, hlit + 257));
        distances = new Huffman(lengths.slice(hlit + 257));
      } else {
        return false;
      }
      // Decode the block's LZ77 stream.
      for (;;) {
        const sym = literals.decode(reader);
        if (sym < 0) return false;
        if (sym < 256) {
          output.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lengthSym = sym - 257;
          if (lengthSym >= LENGTH_BASE.length) return false;
          const extraLen = LENGTH_EXTRA[lengthSym]!;
          const lengthExtra = extraLen === 0 ? 0 : reader.bits(extraLen);
          if (lengthExtra < 0) return false;
          const length = LENGTH_BASE[lengthSym]! + lengthExtra;
          const distSym = distances.decode(reader);
          if (distSym < 0 || distSym >= DIST_BASE.length) return false;
          const distExtra = DIST_EXTRA[distSym]!;
          const distBits = distExtra === 0 ? 0 : reader.bits(distExtra);
          if (distBits < 0) return false;
          const distance = DIST_BASE[distSym]! + distBits;
          if (distance > output.length) return false;
          let from = output.length - distance;
          for (let i = 0; i < length; i += 1) output.push(output[from++]!);
        }
      }
    }
    if (final === 1) return true;
  }
}

/**
 * Inflate the first zlib (RFC 1950) stream found at `input[offset..]`.
 * Returns the data and how many input bytes the whole stream took, or null when malformed.
 *
 * node:zlib does the work: `inflateSync` with the `info` option reports how many input bytes it
 * consumed, which is exactly what a packfile needs (many zlib streams sit back to back). The
 * hand-written decoder below stays as the fallback for streams zlib refuses (a bad adler32, say),
 * so the old tolerance for odd-but-readable input is unchanged.
 */
export function inflateZlibAt(input: Buffer, offset: number, expectedSize?: number): InflateResult | null {
  if (offset + 2 > input.length) return null;
  const cmf = input[offset]!;
  if ((cmf & 0x0f) !== 8) return null;
  const native = inflateNative(input, offset);
  if (native !== null) {
    if (expectedSize !== undefined && native.data.length !== expectedSize) return null;
    return native;
  }
  // Fallback: the hand-written decoder.
  const reader = new BitReader(input, offset + 2, input.length);
  const output: number[] = [];
  const ok = inflateRaw(reader, output);
  if (!ok) return null;
  reader.align();
  const consumedRaw = reader.pos;
  const consumed = 2 + consumedRaw + 4; // header + deflate + adler32
  if (offset + consumed > input.length) return null;
  const data = Buffer.from(output);
  if (expectedSize !== undefined && data.length !== expectedSize) return null;
  return { data, consumed };
}

/** The zlib stream at `offset`, decoded by node:zlib; null when zlib refuses it. */
function inflateNative(input: Buffer, offset: number): InflateResult | null {
  try {
    const result = inflateSync(input.subarray(offset), { info: true });
    const consumed = result.engine.bytesWritten;
    if (!Number.isFinite(consumed) || consumed <= 0 || offset + consumed > input.length) return null;
    return { data: result.buffer, consumed };
  } catch {
    return null;
  }
}

/** Convenience: inflate at `offset` and throw on failure. */
export function mustInflateZlibAt(input: Buffer, offset: number, expectedSize?: number): InflateResult {
  const result = inflateZlibAt(input, offset, expectedSize);
  if (result === null) throw new Error(`bad zlib stream at offset ${offset}`);
  return result;
}
