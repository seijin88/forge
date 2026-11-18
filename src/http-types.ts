// The transport-neutral request and response the forge's handlers work with.
//
// The server speaks HTTP/1.1 on raw sockets (see raw-server.ts), so the handlers never see
// node:http's IncomingMessage or ServerResponse: they see a parsed request (method, target,
// headers, the body already read) and a response that collects a status, headers and a body.

/** One request, parsed. The body is already read: the transport reads it before dispatching. */
export interface ForgeRequest {
  /** The method, upper-cased. */
  method: string;
  /** The request target, path and query as the client wrote them. */
  url: string;
  /** The request headers, names lower-cased. */
  headers: Record<string, string | undefined>;
  /** The request body (empty when the request carried none). */
  body: Buffer;
}

/** The response a handler writes: a status, headers and a body. */
export interface ForgeResponse {
  /** True once the status and headers are set: the reply has started. */
  readonly headersSent: boolean;
  /** Set the status and the headers. Called once, before `end`. */
  writeHead(status: number, headers?: Record<string, string | number>): void;
  /** Finish the response. The body may be a string or bytes. */
  end(body?: string | Buffer): void;
}
