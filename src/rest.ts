// The GitHub REST v3 surface. The git conformance checks create repositories through
// POST /api/v3/user/repos and probe 404s; the full issue/PR/contents surface lands with
// spec-rest.md. Every reply is application/json with a non-empty X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER } from './store.ts';

let requestIdCounter = 0;

export function requestId(): string {
  requestIdCounter += 1;
  return `FR-${requestIdCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export interface RestRequest {
  req: IncomingMessage;
  method: string;
  path: string; // path under /api/v3, without the prefix, no trailing slash ("" for the root)
  query: URLSearchParams;
  forge: Forge;
  token: string | null;
  baseUrl: string;
  rawBody: Buffer;
}

/** Parse a JSON body; null when malformed. */
function parseBody(request: RestRequest): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(request.rawBody.length === 0 ? '{}' : request.rawBody.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function handleRest(request: RestRequest, res: ServerResponse): void {
  const { method, path, query, forge, token, baseUrl } = request;
  void query;

  // Unauthenticated REST: 401 (the git endpoints do their own thing).
  if (token === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // GET /api/v3 root — handled in app.ts (needs X-OAuth-Scopes); nothing else here.
  if (path === '') {
    sendJson(res, 200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
    });
    return;
  }

  // POST /user/repos — create a repository under the token's owner.
  if (path === '/user/repos' && method === 'POST') {
    const body = parseBody(request);
    if (body === null) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      sendJson(res, 422, { message: 'name is invalid' });
      return;
    }
    const existing = forge.getRepo(VIEWER.login, name);
    if (existing !== null) {
      sendJson(res, 422, { message: `name already exists on this account` });
      return;
    }
    const repo = forge.createRepo(
      VIEWER.login,
      name,
      typeof body.description === 'string' ? body.description : '',
      body.private === true,
      body.auto_init === true,
    );
    sendJson(res, 201, repoObject(repo, baseUrl));
    return;
  }

  // GET /user/repos — the viewer's repositories, paginated.
  if (path === '/user/repos' && method === 'GET') {
    const repos = forge.listRepos(VIEWER.login);
    const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const slice = repos.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < repos.length) {
      headers.link = `<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
    }
    sendJson(res, 200, slice.map((repo) => repoObject(repo, baseUrl)), headers);
    return;
  }

  // GET /user — the token's owner.
  if (path === '/user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
    return;
  }

  // /repos/{owner}/{repo}...
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch !== null) {
    const [, owner, name, suffixRaw] = repoMatch as unknown as [string, string, string, string | undefined];
    const suffix = suffixRaw === undefined || suffixRaw === '/' ? '' : suffixRaw;
    const repo = forge.getRepo(owner, name);
    if (repo === null) {
      // A repository belongs to the login the token names: the same name under another owner is 404.
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (suffix === '') {
      if (method === 'GET') {
        sendJson(res, 200, repoObject(repo, baseUrl));
        return;
      }
      if (method === 'PATCH') {
        const body = parseBody(request);
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoObject(repo, baseUrl));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
    }
    // Everything else about a known repo is 404 for now; the full surface lands with spec-rest.
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** The GitHub v3 repository object shape (fields the suite reads; grown from spec-rest.md). */
export function repoObject(repo: NonNullable<ReturnType<Forge['getRepo']>>, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const createdAt = new Date(repo.createdAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const updatedAt = new Date(repo.updatedAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: 5000 + Math.abs(hashString(fullName) % 100000),
    node_id: `R_${Buffer.from(fullName).toString('base64url')}`,
    name: repo.name,
    full_name: fullName,
    owner: {
      login: repo.owner,
      id: VIEWER.id,
      type: 'User',
      site_admin: false,
    },
    private: repo.isPrivate,
    html_url: `${baseUrl}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${fullName}`,
    created_at: createdAt,
    updated_at: updatedAt,
    pushed_at: updatedAt,
    git_url: `git://${baseUrl.slice(7)}/${fullName}.git`,
    ssh_url: `git@${baseUrl.slice(7)}:${fullName}.git`,
    clone_url: `${baseUrl}/${fullName}.git`,
    default_branch: 'main',
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
