// The HTTP/1.1 server, on raw sockets (node:net).
//
// The forge answers every request from memory, so the server has little to do: read a head and a
// body, hand the handler a parsed request, write the reply back as one buffer in one write.
// Keep-alive, Content-Length bodies, chunked bodies and gzip-encoded bodies are handled; the
// suite's client uses none of the rest.
//
// Why raw sockets and not node:http: node:http parses every request into an IncomingMessage,
// builds an OutgoingMessage and writes the head and the body in separate calls. The four timed
// workloads are thousands of small requests, and that bookkeeping costs more than the forge's own
// work. Here a reply is one buffer and one write, with TCP_NODELAY on.

import { createServer, type Server, type Socket } from 'node:net';
import { gunzipSync, inflateSync } from 'node:zlib';
import type { ForgeRequest, ForgeResponse } from './http-types.ts';

const HEAD_END = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY = Buffer.alloc(0);
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 512 * 1024 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

/** A parsed request head. */
interface Head {
  method: string;
  target: string;
  headers: Record<string, string>;
  /** The declared body length; -1 for a chunked body. */
  length: number;
  /** The connection closes after this reply. */
  close: boolean;
  /** Bytes of the head itself, terminator included. */
  size: number;
}

/**
 * Parse the request head out of `buf` at `from`.
 * Returns null when the head is not all there yet, and 'bad' when it is malformed.
 */
function parseHead(buf: Buffer, from: number): Head | null | 'bad' {
  const end = buf.indexOf(HEAD_END, from);
  if (end === -1) return buf.length - from > MAX_HEAD_BYTES ? 'bad' : null;
  const text = buf.toString('latin1', from, end);
  const firstBreak = text.indexOf('\r\n');
  const line = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const space = line.indexOf(' ');
  const lastSpace = line.lastIndexOf(' ');
  if (space <= 0 || lastSpace <= space) return 'bad';
  const version = line.slice(lastSpace + 1);
  const target = line.slice(space + 1, lastSpace);
  if (!version.startsWith('HTTP/1.') || target === '') return 'bad';

  const headers: Record<string, string> = {};
  let at = firstBreak === -1 ? text.length : firstBreak + 2;
  while (at < text.length) {
    let next = text.indexOf('\r\n', at);
    if (next === -1) next = text.length;
    const colon = text.indexOf(':', at);
    if (colon === -1 || colon > next) return 'bad';
    let valueStart = colon + 1;
    while (valueStart < next && text.charCodeAt(valueStart) === 32) valueStart += 1;
    const name = text.slice(at, colon).toLowerCase();
    const value = text.slice(valueStart, next);
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
    at = next + 2;
  }

  let length = 0;
  const encoding = headers['transfer-encoding'];
  if (encoding !== undefined && encoding.toLowerCase().includes('chunked')) {
    length = -1;
  } else if (headers['content-length'] !== undefined) {
    const parsed = Number(headers['content-length']);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return 'bad';
    length = parsed;
  }
  const connection = headers.connection === undefined ? '' : headers.connection.toLowerCase();
  return {
    method: line.slice(0, space),
    target,
    headers,
    length,
    close: connection === 'close' || (version === 'HTTP/1.0' && connection !== 'keep-alive'),
    size: end + 4 - from,
  };
}

/**
 * Decode a chunked body. Returns 'more' when the last chunk has not arrived, and null when the
 * framing is broken.
 */
function dechunk(raw: Buffer): Buffer | 'more' | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', at);
    if (lineEnd === -1) return raw.length - at > 32 ? null : 'more';
    const size = parseInt(raw.toString('latin1', at, lineEnd).split(';')[0].trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (size === 0) return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    const start = lineEnd + 2;
    if (start + size + 2 > raw.length) return 'more';
    parts.push(raw.subarray(start, start + size));
    at = start + size + 2;
  }
}

/** The response a handler writes: it collects the reply and puts it on the socket in one write. */
class SocketResponse implements ForgeResponse {
  private status = 200;
  private headers: Record<string, string | number> = {};
  private body: Buffer = EMPTY;
  private done = false;
  private readonly socket: Socket;
  private readonly close: boolean;
  private readonly headOnly: boolean;

  constructor(socket: Socket, close: boolean, headOnly: boolean) {
    this.socket = socket;
    this.close = close;
    this.headOnly = headOnly;
  }

  /** True once the reply has started: the status and headers are set. */
  get headersSent(): boolean {
    return this.done;
  }

  writeHead(status: number, headers?: Record<string, string | number>): void {
    this.status = status;
    if (headers !== undefined) this.headers = headers;
  }

  end(body?: string | Buffer): void {
    if (this.done) return;
    this.done = true;
    this.body = body === undefined ? EMPTY : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    this.write();
  }

  private write(): void {
    const status = this.status;
    const headers = this.headers;
    const body = this.body;
    let head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\n`;
    let hasLength = false;
    for (const name in headers) {
      const value = headers[name];
      if (value === undefined) continue;
      head += `${name}: ${value}\r\n`;
      if (name === 'content-length') hasLength = true;
    }
    // 204 and 304 carry no body and no length.
    const bodyless = status === 204 || status === 304;
    if (!hasLength && !bodyless) head += `content-length: ${body.length}\r\n`;
    if (this.close) head += 'connection: close\r\n';
    head += '\r\n';
    if (bodyless || this.headOnly || body.length === 0) {
      this.socket.write(head, 'latin1');
    } else {
      // One buffer, one write: the kernel sees one segment.
      const headBytes = Buffer.byteLength(head);
      const out = Buffer.allocUnsafe(headBytes + body.length);
      out.write(head, 0, 'latin1');
      body.copy(out, headBytes);
      this.socket.write(out);
    }
    if (this.close) this.socket.end();
  }
}

/** The body as the handler sees it: the bytes the client sent, decompressed when it compressed them. */
function decodeBody(head: Head, body: Buffer): Buffer {
  const coding = head.headers['content-encoding'];
  if (coding === undefined || body.length === 0) return body;
  const name = coding.toLowerCase();
  if (name === 'gzip' || name === 'x-gzip') return gunzipSync(body);
  if (name === 'deflate') return inflateSync(body);
  return body;
}

/** Build the request the handler sees. */
function toForgeRequest(head: Head, body: Buffer): ForgeRequest {
  return {
    method: head.method === 'HEAD' ? 'GET' : head.method,
    url: head.target,
    headers: head.headers,
    body,
  };
}

/**
 * Serve one connection: parse requests, hand them to the handler and write the replies.
 * A request whose body has not arrived yet waits for the rest of it.
 */
function attach(socket: Socket, handle: (request: ForgeRequest, response: ForgeResponse) => void): void {
  socket.setNoDelay(true);
  /** Bytes of a head that has not arrived whole yet. */
  let pending: Buffer | null = null;
  /** The request whose body is still arriving, and what has arrived of it. */
  let current: Head | null = null;
  let chunks: Buffer[] = [];
  let have = 0;

  const refuse = (status: number, message: string): void => {
    const body = Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8');
    const head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`;
    socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    socket.end();
    current = null;
    pending = null;
    chunks = [];
    have = 0;
  };

  const respond = (head: Head, body: Buffer): void => {
    let request: ForgeRequest;
    try {
      request = toForgeRequest(head, decodeBody(head, body));
    } catch {
      refuse(400, 'Bad Request');
      return;
    }
    const response = new SocketResponse(socket, head.close, head.method === 'HEAD');
    try {
      handle(request, response);
    } catch (error) {
      if (!response.done) {
        const text = `${JSON.stringify({ message: error instanceof Error ? error.message : 'internal error' })}\n`;
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
        response.end(text);
      }
    }
  };

  /** Feed body bytes to the request in flight; returns the bytes that belong to the next request. */
  const feedBody = (data: Buffer): Buffer | null => {
    const head = current as Head;
    if (head.length >= 0) {
      const need = head.length - have;
      if (data.length < need) {
        chunks.push(data);
        have += data.length;
        return null;
      }
      chunks.push(need === data.length ? data : data.subarray(0, need));
      const body = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      current = null;
      chunks = [];
      have = 0;
      respond(head, body);
      return need === data.length ? null : data.subarray(need);
    }
    // A chunked body ends with a zero-size chunk; it is decoded once that has arrived.
    chunks.push(data);
    have += data.length;
    if (have > MAX_BODY_BYTES) {
      refuse(413, 'Payload Too Large');
      return null;
    }
    const whole = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    const body = dechunk(whole);
    if (body === 'more') {
      chunks = [whole];
      return null;
    }
    current = null;
    chunks = [];
    have = 0;
    if (body === null) {
      refuse(400, 'Bad Request');
      return null;
    }
    respond(head, body);
    return null;
  };

  socket.on('data', (chunk: Buffer) => {
    let data: Buffer | null = chunk;
    if (current !== null) {
      data = feedBody(chunk);
      if (data === null) return;
    } else if (pending !== null) {
      data = Buffer.concat([pending, chunk]);
      pending = null;
    }
    let at = 0;
    while (at < data.length) {
      const head = parseHead(data, at);
      if (head === null) {
        pending = at === 0 ? data : data.subarray(at);
        return;
      }
      if (head === 'bad') {
        refuse(400, 'Bad Request');
        return;
      }
      at += head.size;
      if (head.length === 0) {
        respond(head, EMPTY);
        continue;
      }
      if (head.length > MAX_BODY_BYTES) {
        refuse(413, 'Payload Too Large');
        return;
      }
      const expect = head.headers.expect;
      if (expect !== undefined && expect.toLowerCase() === '100-continue') {
        socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      }
      if (head.length > 0 && data.length - at >= head.length) {
        // The whole body came with the head: no copy, no state.
        respond(head, data.subarray(at, at + head.length));
        at += head.length;
        continue;
      }
      current = head;
      const rest = at < data.length ? feedBody(data.subarray(at)) : null;
      if (rest === null) return;
      data = rest;
      at = 0;
    }
  });
  socket.on('error', () => {
    socket.destroy();
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createForgeServer(handle: (request: ForgeRequest, response: ForgeResponse) => void): Server {
  return createServer({ noDelay: true, keepAlive: true }, (socket) => {
    attach(socket, handle);
  });
}
