// pkt-line framing for the git smart HTTP protocol (gitprotocol-common).
// A pkt-line is a 4-hex-digit length prefix (counting itself) followed by payload bytes.
// Special lengths: 0000 flush-pkt, 0001 delim-pkt (v2), 0002 response-end (v2).

export const FLUSH_PKT = '0000';
export const DELIM_PKT = '0001';
export const RESPONSE_END_PKT = '0002';

/** Encode one pkt-line: `encodePktLine('version 2\n')` -> '000bversion 2\n'. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = data.length + 4;
  if (len > 65520) throw new Error(`pkt-line too long: ${len}`);
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const flushPkt = (): Buffer => Buffer.from('0000', 'ascii');
export const delimPkt = (): Buffer => Buffer.from('0001', 'ascii');
export const responseEndPkt = (): Buffer => Buffer.from('0002', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktKind;
  /** Payload bytes for kind === 'data' (length prefix stripped). */
  data?: Buffer;
}

/** Decode every pkt-line in a buffer. Throws on a truncated final line. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) throw new Error(`truncated pkt-line header at ${off}`);
    const hex = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length prefix ${JSON.stringify(hex)} at ${off}`);
    const len = parseInt(hex, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error(`bad pkt-line length ${len} at ${off}`);
    out.push({ kind: 'data', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/** The data payloads of every data pkt-line, as strings. */
export function pktStrings(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((p): p is { kind: 'data'; data: Buffer } => p.kind === 'data')
    .map((p) => p.data!.toString('utf8'));
}
