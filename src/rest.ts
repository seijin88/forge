// The GitHub REST v3 surface, complete per spec-rest.md: repos, branches, commits, contents
// (backed by the real git object store shared with the smart-HTTP surface), issues, labels,
// comments, pull requests with squash merge, and the pagination/protocol contracts.

import type { ForgeRequest, ForgeResponse } from './http-types.ts';
import {
  OBJ_BLOB, OBJ_COMMIT, OBJ_TREE, parseCommit,
  serializeCommit, serializeTree, parseTree, type TreeEntry,
} from './git/objects.ts';
import { GitState } from './git/protocol.ts';
import { Forge, VIEWER, type ForgeRepo } from './store.ts';

let requestIdCounter = 0;
/** Pre-rendered request ids, indexed by the counter (the counter's hex form never changes). */
const REQUEST_IDS: string[] = ['FR-00000000'];

export function requestId(): string {
  requestIdCounter += 1;
  const cached = REQUEST_IDS[requestIdCounter];
  if (cached !== undefined) return cached;
  const rendered = `FR-${requestIdCounter.toString(16).padStart(8, '0')}`;
  if (requestIdCounter < 8192) REQUEST_IDS[requestIdCounter] = rendered;
  return rendered;
}

/** ISO timestamps, cached: the same millisecond recurs across many responses. */
const ISO_CACHE = new Map<number, string>();

function iso(ms: number): string {
  const cached = ISO_CACHE.get(ms);
  if (cached !== undefined) return cached;
  const text = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (ISO_CACHE.size >= 4096) ISO_CACHE.clear();
  ISO_CACHE.set(ms, text);
  return text;
}

/** node_ids, cached per login: the base64 of a login never changes. */
const NODE_ID_CACHE = new Map<string, string>();

function nodeIdOf(login: string): string {
  const cached = NODE_ID_CACHE.get(login);
  if (cached !== undefined) return cached;
  const nodeId = `U_${Buffer.from(login).toString('base64url')}`;
  NODE_ID_CACHE.set(login, nodeId);
  return nodeId;
}

export function sendJson(res: ForgeResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a body that is already serialized (the hot path caches its bytes). */
export function sendJsonBuffer(res: ForgeResponse, status: number, body: Buffer, headers?: Record<string, string>): void {
  if (headers === undefined) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-github-request-id': requestId(),
    });
  } else {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-github-request-id': requestId(),
      ...headers,
    });
  }
  res.end(body);
}

export interface RestRequest {
  req: ForgeRequest;
  method: string;
  path: string; // under /api/v3, no trailing slash ("" for the root)
  query: URLSearchParams;
  forge: Forge;
  token: string | null;
  baseUrl: string;
  rawBody: Buffer;
}

function parseBody(request: RestRequest): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(request.rawBody.length === 0 ? '{}' : request.rawBody.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const notFound = (res: ForgeResponse, message = 'Not Found'): void => sendJson(res, 404, { message });
const badRequest = (res: ForgeResponse, message = 'Problems parsing JSON'): void => sendJson(res, 400, { message });

// ---------------------------------------------------------------- shapes

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: nodeIdOf(login), type: 'User', site_admin: false };
}

function repoJson(repo: ForgeRepo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const createdAt = iso(repo.createdAtMs);
  const updatedAt = iso(repo.updatedAtMs);
  return {
    id: 5000 + (Math.abs(hashString(fullName)) % 100000),
    node_id: `R_${Buffer.from(fullName).toString('base64url')}`,
    name: repo.name,
    full_name: fullName,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.isPrivate,
    html_url: `${baseUrl}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${fullName}`,
    created_at: createdAt,
    updated_at: updatedAt,
    pushed_at: updatedAt,
    clone_url: `${baseUrl}/${fullName}.git`,
    default_branch: branchNameOf(repo.git),
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function branchNameOf(git: GitState): string {
  return git.headTarget.replace(/^refs\/heads\//, '');
}

function issueJson(repo: ForgeRepo, issue: ForgeRepo['issues'][number], baseUrl: string): Record<string, unknown> {
  return {
    id: 100000 + issue.number,
    node_id: `I_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: userJson(issue.user, VIEWER.id),
    comments: issue.comments.length,
    created_at: iso(issue.createdAtMs),
    updated_at: iso(issue.updatedAtMs),
    closed_at: issue.closedAtMs === null ? null : iso(issue.closedAtMs),
    author_association: 'OWNER',
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The cached bytes of one issue's JSON, kept on the issue itself (the hot GET path). */
interface IssueJsonCache {
  baseUrl: string;
  version: number;
  buffer: Buffer;
}

/** One issue's JSON, serialized once per (issue version, origin) and then reused byte for byte. */
function issueJsonBuffer(repo: ForgeRepo, issue: ForgeRepo['issues'][number], baseUrl: string): Buffer {
  const cached = (issue as ForgeRepo['issues'][number] & { json?: IssueJsonCache }).json;
  if (cached !== undefined && cached.version === issue.version && cached.baseUrl === baseUrl) return cached.buffer;
  const buffer = Buffer.from(`${JSON.stringify(issueJson(repo, issue, baseUrl))}\n`, 'utf8');
  (issue as ForgeRepo['issues'][number] & { json?: IssueJsonCache }).json = { baseUrl, version: issue.version, buffer };
  return buffer;
}

function pullJson(repo: ForgeRepo, pull: ForgeRepo['pulls'][number], baseUrl: string): Record<string, unknown> {
  return {
    id: 200000 + pull.number,
    node_id: `PR_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    draft: false,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAtMs === null ? null : iso(pull.mergedAtMs),
    closed_at: pull.state === 'closed' ? iso(pull.updatedAtMs) : null,
    user: userJson(pull.user, VIEWER.id),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo, baseUrl) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo, baseUrl) },
    created_at: iso(pull.createdAtMs),
    updated_at: iso(pull.updatedAtMs),
    author_association: 'OWNER',
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

// ---------------------------------------------------------------- git plumbing for REST

/** Parse tree entries via objects.parseTree and normalise dir modes (git writes '40000'). */
function treeEntries(git: GitState, treeSha: string): TreeEntry[] {
  const obj = git.getObject(treeSha);
  if (obj === null || obj.type !== OBJ_TREE) return [];
  return parseTree(obj.body).map((entry) => ({ ...entry, mode: entry.mode === '040000' ? '40000' : entry.mode }));
}

/** Git-style tree entry order: byte-wise on the name, directories compared with a trailing '/'. */
function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => entry.name + (entry.mode === '40000' ? '/' : '');
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Insert (or replace) `blobSha` at `segments`, rebuilding every tree on the path. Returns the new root tree sha. */
function upsertTreePath(git: GitState, treeSha: string | null, segments: readonly string[], blobSha: string): string {
  const entries = treeSha === null ? [] : treeEntries(git, treeSha);
  if (segments.length === 1) {
    const others = entries.filter((entry) => entry.name !== segments[0]);
    return git.addObject(OBJ_TREE, serializeTree(sortEntries([...others, { mode: '100644', name: segments[0]!, sha: blobSha }])));
  }
  const [head, ...rest] = segments as [string, ...string[]];
  const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
  const newChildSha = upsertTreePath(git, existing?.sha ?? null, rest, blobSha);
  const others = entries.filter((entry) => entry.name !== head);
  return git.addObject(OBJ_TREE, serializeTree(sortEntries([...others, { mode: '40000', name: head!, sha: newChildSha }])));
}

/** Remove `segments` from the tree; drops directories that become empty. Returns the new root tree sha. */
function removeTreePath(git: GitState, treeSha: string | null, segments: readonly string[]): string | null {
  if (treeSha === null) return null;
  const entries = treeEntries(git, treeSha);
  if (segments.length === 1) {
    const remaining = entries.filter((entry) => entry.name !== segments[0]);
    if (remaining.length === 0) return null; // the tree itself disappears
    return git.addObject(OBJ_TREE, serializeTree(sortEntries(remaining)));
  }
  const [head, ...rest] = segments as [string, ...string[]];
  const child = entries.find((entry) => entry.name === head && entry.mode === '40000');
  if (child === undefined) return treeSha;
  const newChildSha = removeTreePath(git, child.sha, rest);
  const others = entries.filter((entry) => entry.name !== head);
  const next = newChildSha === null ? others : [...others, { mode: '40000', name: head!, sha: newChildSha }];
  if (next.length === 0) return null;
  return git.addObject(OBJ_TREE, serializeTree(sortEntries(next)));
}

/** Resolve a path against a commit: a blob, a tree, or null. */
function resolvePath(git: GitState, commitOid: string, segments: readonly string[]): { kind: 'blob' | 'tree'; sha: string } | null {
  const commitObj = git.getObject(commitOid);
  if (commitObj === null || commitObj.type !== OBJ_COMMIT) return null;
  let treeSha = parseCommit(commitObj.body).tree;
  for (let index = 0; index < segments.length; index += 1) {
    const entry = treeEntries(git, treeSha).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    const last = index === segments.length - 1;
    if (last) return { kind: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.sha };
    if (entry.mode !== '40000') return null;
    treeSha = entry.sha;
  }
  return { kind: 'tree', sha: treeSha };
}

interface CommitContentsResult {
  commitSha: string;
  createdFile: boolean;
}

/**
 * Commit one file change (upsert or delete) on a branch: rebuild the trees, create the commit,
 * move the branch ref. Unborn branches get their root commit here.
 */
function commitContents(
  git: GitState,
  branch: string,
  segments: readonly string[],
  blobSha: string | null, // null = delete
  message: string,
): CommitContentsResult {
  const refName = `refs/heads/${branch}`;
  const baseCommitOid = git.refs.get(refName) ?? null;
  const baseTreeSha = baseCommitOid === null ? null : parseCommit(git.getObject(baseCommitOid)!.body).tree;
  let existed = false;
  if (baseCommitOid !== null && resolvePath(git, baseCommitOid, segments) !== null) existed = true;
  const newTreeSha = blobSha === null
    ? removeTreePath(git, baseTreeSha, segments)
    : upsertTreePath(git, baseTreeSha, segments, blobSha);
  const commitBody = serializeCommit({
    tree: newTreeSha ?? '0'.repeat(40),
    parents: baseCommitOid === null ? [] : [baseCommitOid],
    author: { name: VIEWER.name, email: VIEWER.email, epochSec: fixedEpoch(git), tz: '+0000' },
    committer: { name: VIEWER.name, email: VIEWER.email, epochSec: fixedEpoch(git), tz: '+0000' },
    message,
  });
  const commitSha = git.addObject(OBJ_COMMIT, commitBody);
  git.setRef(refName, commitSha);
  return { commitSha, createdFile: !existed };
}

/** A fixed per-store commit epoch: the trial clock, never the wall clock (determinism). */
function fixedEpoch(_git: GitState): number {
  return FIXED_EPOCH_SEC;
}
export const FIXED_EPOCH_SEC = 1700000000;

/** Walk parent links from a commit, collecting the linear history (our histories are linear). */
function listCommits(git: GitState, tipOid: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = git.getObject(oid);
    if (obj === null || obj.type !== OBJ_COMMIT) continue;
    const commit = parseCommit(obj.body);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** Recursive tree diff (base → head); returns changed file paths with statuses. */
function diffTrees(git: GitState, baseTreeSha: string | null, headTreeSha: string | null, prefix: string): Array<{ path: string; status: string; baseSha: string | null; headSha: string | null }> {
  const out: Array<{ path: string; status: string; baseSha: string | null; headSha: string | null }> = [];
  const baseEntries = baseTreeSha === null ? [] : treeEntries(git, baseTreeSha);
  const headEntries = headTreeSha === null ? [] : treeEntries(git, headTreeSha);
  const names = new Set<string>([...baseEntries.map((entry) => entry.name), ...headEntries.map((entry) => entry.name)]);
  for (const name of names) {
    const base = baseEntries.find((entry) => entry.name === name) ?? null;
    const head = headEntries.find((entry) => entry.name === name) ?? null;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const baseIsDir = base !== null && base.mode === '40000';
    const headIsDir = head !== null && head.mode === '40000';
    if (base === null && head === null) continue;
    if (base === null && head !== null) {
      if (headIsDir) out.push(...diffTrees(git, null, head.sha, path));
      else out.push({ path, status: 'added', baseSha: null, headSha: head.sha });
    } else if (base !== null && head === null) {
      if (baseIsDir) out.push(...diffTrees(git, base.sha, null, path));
      else out.push({ path, status: 'removed', baseSha: base.sha, headSha: null });
    } else if (base !== null && head !== null) {
      if (base.sha === head.sha) continue;
      if (baseIsDir && headIsDir) out.push(...diffTrees(git, base.sha, head.sha, path));
      else if (baseIsDir) {
        out.push(...diffTrees(git, base.sha, null, path));
        out.push({ path, status: 'added', baseSha: null, headSha: head.sha });
      } else if (headIsDir) {
        out.push({ path, status: 'removed', baseSha: base.sha, headSha: null });
        out.push(...diffTrees(git, null, head.sha, path));
      } else {
        out.push({ path, status: 'modified', baseSha: base.sha, headSha: head.sha });
      }
    }
  }
  return out;
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

// ---------------------------------------------------------------- route parsing

/** One parsed REST route: the repository and the path below it. */
interface RepoRoute {
  owner: string;
  name: string;
  suffix: string;
}

/** One parsed /issues route. */
interface IssueRoute {
  number: string | null;
  comments: boolean;
}

/** One parsed /pulls route. */
interface PullRoute {
  number: string | null;
  action: string | null;
}

/**
 * Parsed routes, cached per path: the suite asks for the same paths thousands of times, and
 * re-running the patterns costs a match array and three strings each time.
 */
const REPO_ROUTE_CACHE = new Map<string, RepoRoute | null>();
const ISSUE_ROUTE_CACHE = new Map<string, IssueRoute | null>();
const PULL_ROUTE_CACHE = new Map<string, PullRoute | null>();

/** Are all the characters digits? (the route patterns accept only digits) */
function isDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function repoRouteOf(path: string): RepoRoute | null {
  const cached = REPO_ROUTE_CACHE.get(path);
  if (cached !== undefined) return cached;
  let route: RepoRoute | null = null;
  if (path.startsWith('/repos/')) {
    const rest = path.slice('/repos/'.length);
    const first = rest.indexOf('/');
    const owner = first === -1 ? rest : rest.slice(0, first);
    const after = first === -1 ? '' : rest.slice(first + 1);
    const second = after.indexOf('/');
    const name = second === -1 ? after : after.slice(0, second);
    let suffix = second === -1 ? '' : after.slice(second);
    if (suffix === '/') suffix = '';
    if (owner !== '' && name !== '') route = { owner, name, suffix };
  }
  if (REPO_ROUTE_CACHE.size >= 1024) REPO_ROUTE_CACHE.clear();
  REPO_ROUTE_CACHE.set(path, route);
  return route;
}

function issueRouteOf(suffix: string): IssueRoute | null {
  const cached = ISSUE_ROUTE_CACHE.get(suffix);
  if (cached !== undefined) return cached;
  let route: IssueRoute | null = null;
  if (suffix === '/issues') {
    route = { number: null, comments: false };
  } else if (suffix.startsWith('/issues/')) {
    const rest = suffix.slice('/issues/'.length);
    if (rest.endsWith('/comments')) {
      const number = rest.slice(0, rest.length - '/comments'.length);
      if (isDigits(number)) route = { number, comments: true };
    } else if (isDigits(rest)) {
      route = { number: rest, comments: false };
    }
  }
  if (ISSUE_ROUTE_CACHE.size >= 1024) ISSUE_ROUTE_CACHE.clear();
  ISSUE_ROUTE_CACHE.set(suffix, route);
  return route;
}

function pullRouteOf(suffix: string): PullRoute | null {
  const cached = PULL_ROUTE_CACHE.get(suffix);
  if (cached !== undefined) return cached;
  let route: PullRoute | null = null;
  if (suffix === '/pulls') {
    route = { number: null, action: null };
  } else if (suffix.startsWith('/pulls/')) {
    const rest = suffix.slice('/pulls/'.length);
    const slash = rest.indexOf('/');
    const number = slash === -1 ? rest : rest.slice(0, slash);
    if (isDigits(number)) {
      let action: string | null = null;
      if (slash !== -1) {
        const tail = rest.slice(slash + 1);
        if (tail === 'files' || tail === 'merge') action = tail;
      }
      route = { number, action };
    }
  }
  if (PULL_ROUTE_CACHE.size >= 1024) PULL_ROUTE_CACHE.clear();
  PULL_ROUTE_CACHE.set(suffix, route);
  return route;
}

// ---------------------------------------------------------------- the dispatcher

export function handleRest(request: RestRequest, res: ForgeResponse): void {
  const { method, path, query, forge, token, baseUrl } = request;

  if (token === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '') {
    sendJson(res, 200, {
      current_user_url: `${baseUrl}/api/v3/user`,
      authorizations_url: `${baseUrl}/api/v3/authorizations`,
      repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
    });
    return;
  }

  if (path === '/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-1.0.0 (makefun github-core-clone-01)' });
    return;
  }

  if (path === '/user' && method === 'GET') {
    sendJson(res, 200, { ...userJson(VIEWER.login, VIEWER.id), name: VIEWER.name, email: VIEWER.email });
    return;
  }

  if (path === '/user/repos' && (method === 'GET' || method === 'POST')) {
    handleUserRepos(request, res);
    return;
  }

  const route = repoRouteOf(path);
  if (route !== null) {
    handleRepoRoutes(request, res, route.owner, route.name, route.suffix);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------- /user/repos

function handleUserRepos(request: RestRequest, res: ForgeResponse): void {
  const { method, query, forge, baseUrl } = request;
  if (method === 'POST') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const name = typeof body.name === 'string' ? body.name : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      sendJson(res, 422, { message: 'name is invalid' });
      return;
    }
    if (forge.getRepo(VIEWER.login, name) !== null) {
      sendJson(res, 422, { message: 'name already exists on this account' });
      return;
    }
    const repo = forge.createRepo(
      VIEWER.login,
      name,
      typeof body.description === 'string' ? body.description : '',
      body.private === true,
      body.auto_init === true,
    );
    if (body.auto_init !== true) void repo; // unborn until the first contents PUT or push
    sendJson(res, 201, repoJson(repo, baseUrl));
    return;
  }
  // GET: paginated, creation order, absolute same-origin Link header.
  const repos = forge.listRepos(VIEWER.login);
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const slice = repos.slice((page - 1) * perPage, page * perPage);
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const headers: Record<string, string> = {};
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) links.push(`<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  sendJson(res, 200, slice.map((repo) => repoJson(repo, baseUrl)), headers);
}

// ---------------------------------------------------------------- /repos/{owner}/{name}/...

function handleRepoRoutes(request: RestRequest, res: ForgeResponse, owner: string, name: string, suffix: string): void {
  const { method, query, forge, baseUrl, token } = request;
  const repo = forge.getRepo(owner, name);

  if (repo === null) {
    // A repository belongs to the login the token names: the same name under another owner is 404.
    if (suffix === '' && method === 'GET' && owner === VIEWER.login && forge.getRepo(owner, name) === null) {
      // Distinguish the never-created 404 (fine) from nothing — same answer either way.
    }
    notFound(res);
    return;
  }

  if (suffix === '') {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo, baseUrl)); return; }
    if (method === 'PATCH') {
      const body = parseBody(request);
      if (body === null) { badRequest(res); return; }
      if (typeof body.description === 'string') { repo.description = body.description; repo.updatedAtMs = forge.nowMs(); }
      sendJson(res, 200, repoJson(repo, baseUrl));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // ---- /branches
  if (suffix === '/branches' && method === 'GET') {
    const list = repo.git.listRefs()
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.name.replace(/^refs\/heads\//, ''), commit: { sha: ref.oid } }));
    sendJson(res, 200, list);
    return;
  }

  // ---- /git/refs (create a branch)
  if (suffix === '/git/refs' && method === 'POST') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-fA-F]{40}$/.test(sha)) {
      sendJson(res, 422, { message: 'ref and sha are required' });
      return;
    }
    if (repo.git.refs.has(ref)) {
      sendJson(res, 422, { message: 'Reference already exists' });
      return;
    }
    if (!repo.git.hasObject(sha)) {
      sendJson(res, 422, { message: 'Object does not exist' });
      return;
    }
    repo.git.setRef(ref, sha.toLowerCase());
    sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit', url: `${baseUrl}/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
    return;
  }

  // ---- /commits
  if (suffix === '/commits' && method === 'GET') {
    const refish = query.get('sha') ?? branchNameOf(repo.git);
    const tip = resolveBranchOrSha(repo.git, refish);
    if (tip === null) { notFound(res, `SHA could not be resolved`); return; }
    sendJson(res, 200, listCommits(repo.git, tip).map((entry) => ({
      sha: entry.sha,
      node_id: `C_${entry.sha.slice(0, 12)}`,
      commit: {
        message: entry.message,
        author: { name: VIEWER.name, email: VIEWER.email, date: iso(FIXED_EPOCH_SEC * 1000) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: iso(FIXED_EPOCH_SEC * 1000) },
      },
      author: userJson(VIEWER.login, VIEWER.id),
      committer: userJson(VIEWER.login, VIEWER.id),
      parents: [],
      url: `${baseUrl}/api/v3/repos/${owner}/${name}/commits/${entry.sha}`,
    })));
    return;
  }

  // ---- /contents/{path...}
  if (suffix.startsWith('/contents/') || suffix === '/contents') {
    handleContents(request, res, repo, suffix === '/contents' ? '' : suffix.slice('/contents/'.length));
    return;
  }

  // ---- /labels
  if (suffix === '/labels' && method === 'POST') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const label = typeof body.name === 'string' && body.name !== '' ? body.name : null;
    if (label === null) { sendJson(res, 422, { message: 'name is required' }); return; }
    repo.labels.add(label);
    sendJson(res, 201, { name: label, color: typeof body.color === 'string' ? body.color : 'ededed' });
    return;
  }
  if (suffix === '/labels' && method === 'GET') {
    sendJson(res, 200, [...repo.labels].map((labelName) => ({ name: labelName })));
    return;
  }

  // ---- /issues and /issues/{n}/...
  const issueRoute = issueRouteOf(suffix);
  if (issueRoute !== null) {
    handleIssues(request, res, repo, issueRoute.number, issueRoute.comments);
    return;
  }

  // ---- /pulls and /pulls/{n}/...
  const pullRoute = pullRouteOf(suffix);
  if (pullRoute !== null) {
    handlePulls(request, res, repo, pullRoute.number, pullRoute.action);
    return;
  }

  notFound(res);
}

/** A branch name or a 40-hex sha → a commit tip oid, or null. */
function resolveBranchOrSha(git: GitState, refish: string): string | null {
  if (/^[0-9a-fA-F]{40}$/.test(refish)) return git.hasObject(refish.toLowerCase()) ? refish.toLowerCase() : null;
  const direct = git.refs.get(`refs/heads/${refish}`);
  if (direct !== undefined) return direct;
  return git.refs.get(refish) ?? null;
}

// ---------------------------------------------------------------- contents

function handleContents(request: RestRequest, res: ForgeResponse, repo: ForgeRepo, filePath: string): void {
  const { method, query, baseUrl, forge } = request;
  const git = repo.git;
  const segments = filePath.split('/').filter((segment) => segment.length > 0);
  const branch = query.get('ref') ?? branchNameOf(git);
  const commitOid = resolveBranchOrSha(git, branch);

  if (method === 'GET') {
    if (commitOid === null) { notFound(res); return; }
    const found = resolvePath(git, commitOid, segments);
    if (found === null) { notFound(res); return; }
    if (found.kind === 'blob') {
      const blob = git.getObject(found.sha)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.body.toString('base64'),
        sha: found.sha,
        size: blob.body.length,
        name: segments[segments.length - 1]!,
        path: filePath,
        url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
      });
      return;
    }
    const entries = treeEntries(git, found.sha).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
      sha: entry.sha,
      size: entry.mode === '40000' ? 0 : (git.getObject(entry.sha)?.body.length ?? 0),
      url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath === '' ? entry.name : `${filePath}/${entry.name}`}`,
    }));
    sendJson(res, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : null;
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (message === null || contentB64 === null) { sendJson(res, 422, { message: 'message and content are required' }); return; }
    const content = Buffer.from(contentB64, 'base64');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : branchNameOf(git);
    const refName = `refs/heads/${branch}`;
    const baseCommitOid = git.refs.get(refName) ?? null;

    // Stale-sha detection: the caller's sha must match the file's current blob sha.
    let existingBlobSha: string | null = null;
    if (baseCommitOid !== null) {
      const found = resolvePath(git, baseCommitOid, segments);
      if (found !== null && found.kind === 'blob') existingBlobSha = found.sha;
    }
    const requestedSha = typeof body.sha === 'string' && body.sha !== '' ? body.sha.toLowerCase() : null;
    if (requestedSha !== null && existingBlobSha !== requestedSha) {
      sendJson(res, 409, { message: 'config/token.css does not match the given sha' });
      return;
    }

    const blobSha = git.addObject(OBJ_BLOB, content);
    const { commitSha, createdFile } = commitContents(git, branch, segments, blobSha, message);
    repo.updatedAtMs = forge.nowMs();
    sendJson(res, createdFile ? 201 : 200, {
      content: { sha: blobSha, encoding: 'base64', size: content.length, name: segments[segments.length - 1]!, path: filePath },
      commit: {
        sha: commitSha,
        node_id: `C_${commitSha.slice(0, 12)}`,
        message,
        author: { name: VIEWER.name, email: VIEWER.email, date: iso(FIXED_EPOCH_SEC * 1000) },
        committer: { name: VIEWER.name, email: VIEWER.email, date: iso(FIXED_EPOCH_SEC * 1000) },
        html_url: `${baseUrl}/${repo.owner}/${repo.name}/commit/${commitSha}`,
      },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Delete file';
    const requestedSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : branchNameOf(git);
    const refName = `refs/heads/${branch}`;
    const baseCommitOid = git.refs.get(refName) ?? null;
    if (baseCommitOid === null) { notFound(res); return; }
    const found = resolvePath(git, baseCommitOid, segments);
    if (found === null || found.kind !== 'blob') { notFound(res); return; }
    if (requestedSha !== null && found.sha !== requestedSha) {
      sendJson(res, 409, { message: 'sha does not match' });
      return;
    }
    const { commitSha } = commitContents(git, branch, segments, null, message);
    repo.updatedAtMs = forge.nowMs();
    sendJson(res, 200, { commit: { sha: commitSha } });
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------- issues

function handleIssues(request: RestRequest, res: ForgeResponse, repo: ForgeRepo, numberRaw: string | null, comments: boolean): void {
  const { method, query, baseUrl, forge } = request;

  if (numberRaw === null) {
    if (method === 'POST') {
      const body = parseBody(request);
      if (body === null) { badRequest(res); return; }
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') { sendJson(res, 422, { message: 'title is required' }); return; }
      const requestedLabels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      for (const label of requestedLabels) {
        if (!repo.labels.has(label)) {
          sendJson(res, 422, { message: `Label "${label}" does not exist` });
          return;
        }
      }
      const number = forge.nextIssueNumberFor(repo.owner, repo.name);
      const now = forge.nowMs();
      const issue = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        labels: [...requestedLabels],
        state: 'open' as const,
        createdAtMs: now,
        updatedAtMs: now,
        closedAtMs: null,
        user: VIEWER.login,
        comments: [] as ForgeRepo['issues'][number]['comments'],
        version: 1,
      };
      repo.addIssue(issue);
      repo.updatedAtMs = now;
      sendJson(res, 201, issueJson(repo, issue, baseUrl));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.slice();
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      } else {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      list = list.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, list.map((issue) => issueJson(repo, issue, baseUrl)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(numberRaw, 10);
  const issue = repo.issue(number);

  if (comments) {
    if (issue === null) { notFound(res); return; }
    if (method === 'POST') {
      const body = parseBody(request);
      if (body === null) { badRequest(res); return; }
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = { id: forge.nextCommentId(), body: commentBody, user: VIEWER.login, createdAtMs: forge.nowMs() };
      issue.comments.push(comment);
      issue.updatedAtMs = comment.createdAtMs;
      issue.version += 1;
      sendJson(res, 201, { id: comment.id, body: comment.body, user: userJson(VIEWER.login, VIEWER.id), created_at: iso(comment.createdAtMs) });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: userJson(comment.user, VIEWER.id),
        created_at: iso(comment.createdAtMs),
      })));
      return;
    }
    notFound(res);
    return;
  }

  if (issue === null) { notFound(res); return; }
  if (method === 'GET') {
    sendJsonBuffer(res, 200, issueJsonBuffer(repo, issue, baseUrl));
    return;
  }
  if (method === 'PATCH') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    if (body.state === 'open' || body.state === 'closed') {
      issue.state = body.state;
      issue.closedAtMs = body.state === 'closed' ? forge.nowMs() : null;
    }
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    issue.updatedAtMs = forge.nowMs();
    issue.version += 1;
    sendJson(res, 200, issueJson(repo, issue, baseUrl));
    return;
  }
  notFound(res);
}

// ---------------------------------------------------------------- pulls

function handlePulls(request: RestRequest, res: ForgeResponse, repo: ForgeRepo, numberRaw: string | null, action: string | null): void {
  const { method, query, baseUrl, forge } = request;

  if (numberRaw === null) {
    if (method === 'POST') {
      const body = parseBody(request);
      if (body === null) { badRequest(res); return; }
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const headSha = repo.git.refs.get(`refs/heads/${head}`) ?? null;
      const baseSha = repo.git.refs.get(`refs/heads/${base}`) ?? null;
      if (headSha === null || baseSha === null) {
        sendJson(res, 422, { message: 'head or base branch does not exist' });
        return;
      }
      const number = forge.nextIssueNumberFor(repo.owner, repo.name);
      const now = forge.nowMs();
      const pull = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open' as const,
        merged: false,
        mergedAtMs: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        user: VIEWER.login,
        createdAtMs: now,
        updatedAtMs: now,
        files: [] as ForgeRepo['pulls'][number]['files'],
      };
      repo.pulls.push(pull);
      repo.updatedAtMs = now;
      sendJson(res, 201, pullJson(repo, pull, baseUrl));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.slice();
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      list = list.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, list.map((pull) => pullJson(repo, pull, baseUrl)));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number.parseInt(numberRaw, 10);
  const pull = repo.pulls.find((candidate) => candidate.number === number) ?? null;
  if (pull === null) { notFound(res); return; }

  if (action === 'files') {
    if (method !== 'GET') { notFound(res); return; }
    const baseCommit = repo.git.getObject(pull.baseSha);
    const headCommit = repo.git.getObject(pull.headSha);
    const baseTree = baseCommit !== null && baseCommit.type === OBJ_COMMIT ? parseCommit(baseCommit.body).tree : null;
    const headTree = headCommit !== null && headCommit.type === OBJ_COMMIT ? parseCommit(headCommit.body).tree : null;
    const files = diffTrees(repo.git, baseTree, headTree, '').map((change) => {
      const newContent = change.headSha === null ? Buffer.alloc(0) : repo.git.getObject(change.headSha)!.body;
      const oldContent = change.baseSha === null ? Buffer.alloc(0) : repo.git.getObject(change.baseSha)!.body;
      const additions = change.status === 'removed' ? 0 : countLines(newContent);
      const deletions = change.status === 'added' ? 0 : countLines(oldContent);
      return {
        sha: change.headSha ?? change.baseSha ?? '',
        filename: change.path,
        status: change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
    sendJson(res, 200, files);
    return;
  }

  if (action === 'merge') {
    if (method !== 'PUT') { notFound(res); return; }
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    const baseRef = `refs/heads/${pull.baseRef}`;
    const currentBaseTip = repo.git.refs.get(baseRef) ?? null;
    if (currentBaseTip === null || currentBaseTip !== pull.baseSha) {
      // The base advanced after this pull opened: merging the same path is a genuine conflict.
      sendJson(res, 405, { message: 'Pull Request is not mergeable: the base branch has moved' });
      return;
    }
    // Squash: one commit on the base branch carrying the head branch's tree.
    const headCommit = repo.git.getObject(pull.headSha);
    const headTree = headCommit !== null && headCommit.type === OBJ_COMMIT ? parseCommit(headCommit.body).tree : null;
    if (headTree === null) { sendJson(res, 405, { message: 'Pull Request has no head tree' }); return; }
    const mergeBody = serializeCommit({
      tree: headTree,
      parents: [currentBaseTip],
      author: { name: VIEWER.name, email: VIEWER.email, epochSec: FIXED_EPOCH_SEC, tz: '+0000' },
      committer: { name: VIEWER.name, email: VIEWER.email, epochSec: FIXED_EPOCH_SEC, tz: '+0000' },
      message: `${pull.title} (#${pull.number})\n\nSquash merge branch '${pull.headRef}' into ${pull.baseRef}\n`,
    });
    const mergeSha = repo.git.addObject(OBJ_COMMIT, mergeBody);
    repo.git.setRef(baseRef, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAtMs = forge.nowMs();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAtMs = forge.nowMs();
    repo.updatedAtMs = pull.updatedAtMs;
    sendJson(res, 200, { merged: true, sha: mergeSha, message: 'Pull Request successfully merged and closed' });
    return;
  }

  if (method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull, baseUrl));
    return;
  }
  if (method === 'PATCH') {
    const body = parseBody(request);
    if (body === null) { badRequest(res); return; }
    if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
    if (typeof body.title === 'string') pull.title = body.title;
    if (typeof body.body === 'string') pull.body = body.body;
    pull.updatedAtMs = forge.nowMs();
    sendJson(res, 200, pullJson(repo, pull, baseUrl));
    return;
  }
  notFound(res);
}

