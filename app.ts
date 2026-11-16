// The forge's HTTP surface: the router that dispatches /healthz, the git smart-HTTP endpoints,
// REST v3, GraphQL v4 and MCP. app.ts is the file that grows; main.ts keeps the entry<->env
// lifecycle and must stay as the starter ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest, requestId, sendJson } from './src/rest.ts';
import {
  GitState,
  handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack,
  infoRefsReceive, infoRefsUploadV0, infoRefsUploadV2,
} from './src/git/protocol.ts';
import { decodePktLines } from './src/git/pkt.ts';
import { handleMcp } from './src/mcp.ts';

/** Read a request body to completion (Content-Length known; the suite always sets it). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token, or null when absent. An empty string counts as absent. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = match[1]!.trim();
  return token === '' ? null : token;
}

/** The token the suite presents; unset outside a trial, where any token is accepted. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function tokenIsValid(token: string | null): boolean {
  if (token === null) return false;
  return EXPECTED_TOKEN === '' || token === EXPECTED_TOKEN;
}

/** Is this path a git smart-HTTP path? Returns the parsed parts. */
export function matchGitPath(path: string): { owner: string; repo: string; endpoint: string } | null {
  const match = /^\/([^/]+)\/([^/]+?)\.git(\/(info\/refs|git-upload-pack|git-receive-pack))?$/.exec(path);
  if (match === null) return null;
  const [, owner, repo, , endpointRaw] = match as unknown as [string, string, string, string, string | undefined];
  return { owner, repo, endpoint: endpointRaw === undefined ? '' : `/${endpointRaw}` };
}

/** Dispatch one git smart-HTTP request (`body` is the raw request body; empty for GETs). */
function handleGit(
  res: ServerResponse,
  parts: { owner: string; repo: string; endpoint: string },
  query: URLSearchParams,
  body: Buffer,
  forge: Forge,
  method: string,
  headerWantsV2: boolean,
): void {
  const { owner, repo: repoName, endpoint } = parts;
  const repo = forge.getRepo(owner, repoName);

  if (endpoint === '/info/refs') {
    if (repo === null) {
      // Missing repo: 404 on both services; the server keeps serving.
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const bodyOut = headerWantsV2 ? infoRefsUploadV2() : infoRefsUploadV0(repo.git);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': bodyOut.length,
        'cache-control': 'no-cache',
      });
      res.end(bodyOut);
      return;
    }
    if (service === 'git-receive-pack') {
      const bodyOut = infoRefsReceive(repo.git);
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'content-length': bodyOut.length,
        'cache-control': 'no-cache',
      });
      res.end(bodyOut);
      return;
    }
    sendJson(res, 400, { message: 'unsupported service' });
    return;
  }

  if (endpoint === '/git-upload-pack' && method === 'POST') {
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let bodyOut: Buffer;
    try {
      bodyOut = dispatchUploadPack(repo.git, body, headerWantsV2);
    } catch {
      // Malformed body: any status is accepted; the server must survive and keep serving.
      sendJson(res, 400, { message: 'bad request' });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': bodyOut.length });
    res.end(bodyOut);
    return;
  }

  if (endpoint === '/git-receive-pack' && method === 'POST') {
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let bodyOut: Buffer;
    try {
      bodyOut = handleReceivePack(repo.git, body);
    } catch {
      sendJson(res, 400, { message: 'bad request' });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': bodyOut.length });
    res.end(bodyOut);
    return;
  }

  // A .git path with no recognized endpoint: the suite never sends one.
  sendJson(res, 404, { message: 'Not Found' });
}

/** POST git-upload-pack: v2 command body, or a v0 want/have body when the header is absent. */
function dispatchUploadPack(git: GitState, body: Buffer, headerWantsV2: boolean): Buffer {
  const text = body.toString('latin1');
  const looksV2 = text.startsWith('0014command=') || text.startsWith('0012command=');
  if (headerWantsV2 || looksV2) {
    // One section: command + (agent/object-format) lines, delim, arguments, flush.
    const packets = decodePktLines(body);
    let command = '';
    const args: string[] = [];
    let pastDelim = false;
    for (const pkt of packets) {
      if (pkt.kind === 'flush') break;
      if (pkt.kind === 'delim') { pastDelim = true; continue; }
      if (pkt.kind !== 'data') continue;
      const line = pkt.data!.toString('utf8').replace(/\n$/, '');
      if (!pastDelim) {
        if (line.startsWith('command=')) command = line.slice('command='.length);
        // agent=/object-format= lines are accepted and ignored.
      } else {
        args.push(line);
      }
    }
    if (command === 'ls-refs') return handleLsRefs(git, args);
    if (command === 'fetch') return handleFetchV2(git, args);
    throw new Error(`unknown command ${command}`);
  }
  return handleFetchV0(git, body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = (req.method ?? 'GET').toUpperCase();
      const query = queryOf(req);
      const token = bearerOf(req);
      const headerWantsV2 = (req.headers['git-protocol'] ?? '').toString().trim() === 'version=2';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The git smart-HTTP surface.
      const gitParts = matchGitPath(path);
      if (process.env.FORGE_DEBUG === '1') console.error(`[route] ${method} ${path} gitParts=${JSON.stringify(gitParts)}`);
      if (gitParts !== null) {
        const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        handleGit(res, gitParts, query, body, forge, method, headerWantsV2);
        return;
      }

      const authenticated = tokenIsValid(token);

      // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
      if (path === '/api/v3' || path === '/api/v3/') {
        if (!authenticated) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const origin = originOf(req);
        sendJson(res, 200, {
          current_user_url: `${origin}/api/v3/user`,
          authorizations_url: `${origin}/api/v3/authorizations`,
          repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
          user_repositories_url: `${origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      if (path === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        const { handleGraphQL } = await import('./src/graphql.ts');
        handleGraphQL({ req, res, body, forge, token, authenticated });
        return;
      }

      if (path === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        await handleMcp({ req, res, body, forge, token, authenticated });
        return;
      }

      if (path === '/mcp' && method === 'DELETE') {
        await handleMcp({ req, res, body: Buffer.alloc(0), forge, token, authenticated });
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const restPath = path === '/api/v3/' ? '' : path.slice('/api/v3'.length);
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = body;
        handleRest({ req, method, path: restPath, query, forge, token: authenticated ? token : null, baseUrl: originOf(req), rawBody: body }, res);
        return;
      }

      // Anything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      // Never crash the process on a request: answer 500 JSON and keep serving.
      if (!res.headersSent) {
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'internal error' });
      } else {
        res.end();
      }
      void requestId();
    });
  });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
