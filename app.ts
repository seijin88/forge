// The forge's HTTP surface: the router that dispatches /healthz, the git smart-HTTP endpoints,
// REST v3, GraphQL v4 and MCP. app.ts is the file that grows; main.ts keeps the entry<->env
// lifecycle and must stay as the starter ships it.

import type { Server } from 'node:net';
import { Forge } from './src/store.ts';
import { createForgeServer } from './src/raw-server.ts';
import type { ForgeRequest, ForgeResponse } from './src/http-types.ts';
import { handleRest, requestId, sendJson } from './src/rest.ts';
import {
  GitState,
  handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack,
  infoRefsReceive, infoRefsUploadV0, infoRefsUploadV2,
} from './src/git/protocol.ts';
import { decodePktLines } from './src/git/pkt.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGraphQL } from './src/graphql.ts';

/** The query string of a request that carries none (shared; it is never mutated). */
const EMPTY_QUERY = new URLSearchParams();

/**
 * The request target, split once: the path and the query. The hot path avoids `new URL` (it
 * allocates a URL object and reparses the whole target); unusual targets (absolute form, dot
 * segments) still go through the URL parser so they normalize the same way.
 *
 * The last target is kept: the suite asks for the same paths over and over, and re-splitting
 * them costs a slice and a string hash per request.
 */
let lastRawTarget = '';
let targetPath = '/';
let targetQuery: URLSearchParams = EMPTY_QUERY;

function parseTarget(req: ForgeRequest): void {
  const raw = req.url ?? '/';
  if (raw === lastRawTarget) return;
  lastRawTarget = raw;
  const mark = raw.indexOf('?');
  const path = mark === -1 ? raw : raw.slice(0, mark);
  if (path.startsWith('/') && !path.includes('/.')) {
    targetPath = path;
    targetQuery = mark === -1 ? EMPTY_QUERY : new URLSearchParams(raw.slice(mark + 1));
    return;
  }
  try {
    const parsed = new URL(raw, 'http://entry');
    targetPath = parsed.pathname;
    targetQuery = parsed.searchParams;
  } catch {
    targetPath = '/';
    targetQuery = EMPTY_QUERY;
  }
}

/** The bearer token, or null when absent. An empty string counts as absent. */
function bearerOf(req: ForgeRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // "Bearer <token>" (case-insensitive scheme), parsed without a regular expression and
  // without slicing the scheme out of the header.
  if (header.length < 7) return null;
  if (!isBearerScheme(header)) return null;
  let index = 6;
  while (index < header.length && header.charCodeAt(index) === 32) index += 1; // spaces
  if (index >= header.length) return null;
  const token = header.slice(index).trim();
  return token === '' ? null : token;
}

/** Is the header's scheme "bearer", in any case? */
function isBearerScheme(header: string): boolean {
  const lower = (code: number): number => (code >= 65 && code <= 90 ? code + 32 : code);
  return lower(header.charCodeAt(0)) === 98 /* b */
    && lower(header.charCodeAt(1)) === 101 /* e */
    && lower(header.charCodeAt(2)) === 97 /* a */
    && lower(header.charCodeAt(3)) === 114 /* r */
    && lower(header.charCodeAt(4)) === 101 /* e */
    && lower(header.charCodeAt(5)) === 114 /* r */;
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
  res: ForgeResponse,
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

/** The debug flag, read once: reading process.env per request is slow. */
const FORGE_DEBUG = process.env.FORGE_DEBUG === '1';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW);

  return createForgeServer((req: ForgeRequest, res: ForgeResponse): void => {
    void (async (): Promise<void> => {
      parseTarget(req);
      const path = targetPath;
      const query = targetQuery;
      const method = (req.method ?? 'GET').toUpperCase();
      const token = bearerOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The git smart-HTTP surface. API paths never are one, so they skip the pattern.
      const gitParts = path === '/api/v3' || path.startsWith('/api/') || path === '/mcp'
        ? null
        : matchGitPath(path);
      if (FORGE_DEBUG) console.error(`[route] ${method} ${path} gitParts=${JSON.stringify(gitParts)}`);
      if (gitParts !== null) {
        const headerWantsV2 = (req.headers['git-protocol'] ?? '').toString().trim() === 'version=2';
        const body = method === 'POST' ? req.body : Buffer.alloc(0);
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
        handleGraphQL({ req, res, body: req.body, forge, token, authenticated });
        return;
      }

      if (path === '/mcp' && method === 'POST') {
        await handleMcp({ req, res, body: req.body, forge, token, authenticated });
        return;
      }

      if (path === '/mcp' && method === 'DELETE') {
        await handleMcp({ req, res, body: Buffer.alloc(0), forge, token, authenticated });
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : req.body;
        const restPath = path === '/api/v3/' ? '' : path.slice('/api/v3'.length);
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

/** The origin of a request, cached per Host header (the string never changes during a trial). */
let lastHost = '';
let lastOrigin = '';

function originOf(req: ForgeRequest): string {
  const host = req.headers.host ?? '127.0.0.1';
  if (host !== lastHost) {
    lastHost = host;
    lastOrigin = `http://${host}`;
  }
  return lastOrigin;
}
