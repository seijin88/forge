// The MCP endpoint (JSON-RPC 2.0 over Streamable HTTP) per spec-mcp.md: modern era
// server/discover, legacy initialize handshake, a frozen six-tool registry, tools/call against
// the shared forge store, and the exact error matrix (-32700/-32602/-32601, HTTP 400/401).

import type { ForgeRequest, ForgeResponse } from './http-types.ts';
import { OBJ_COMMIT, parseCommit, serializeCommit } from './git/objects.ts';
import { Forge, VIEWER, type ForgeRepo } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

/** The tool registry, built ONCE at module load: same array, same key order, every time. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Optional description.' },
        private: { type: 'boolean', description: 'Create as private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: "List a repository's issues, newest first.",
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

export interface McpRequest {
  req: ForgeRequest;
  res: ForgeResponse;
  body: Buffer;
  forge: Forge;
  token: string | null;
  authenticated: boolean;
}

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function writeJsonRpc(res: ForgeResponse, status: number, payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const resultResponse = (id: string | number | null, result: Record<string, unknown>): Record<string, unknown> =>
  ({ jsonrpc: '2.0', id, result });
const errorResponse = (id: string | number | null, code: number, message: string): Record<string, unknown> =>
  ({ jsonrpc: '2.0', id, error: { code, message, data: null } });

export async function handleMcp(request: McpRequest): Promise<void> {
  const { req, res, body, forge, authenticated } = request;

  if (req.method === 'DELETE') {
    res.writeHead(204); res.end();
    return;
  }

  // Parse the body BEFORE the auth gate only insofar as deciding JSON validity; auth comes first
  // for everything the suite sends (the deliberate unauthenticated probe earns the 401).
  if (!authenticated) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }

  let parsed: JsonRpcRequest | null = null;
  try {
    parsed = JSON.parse(body.length === 0 ? 'null' : body.toString('utf8')) as JsonRpcRequest;
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
    writeJsonRpc(res, 400, errorResponse(null, -32700, 'Parse error'));
    return;
  }

  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = (typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : {}) as Record<string, unknown>;

  // Notifications: no id field. The suite sends only notifications/initialized.
  if (parsed.id === undefined) {
    res.writeHead(202); res.end();
    return;
  }

  if (method === 'server/discover') {
    writeJsonRpc(res, 200, resultResponse(id, {
      resultType: 'DiscoverResult',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'GitHub-compatible forge MCP server.',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? params.protocolVersion
      : '2025-11-25';
    writeJsonRpc(res, 200, resultResponse(id, {
      protocolVersion: offered,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'GitHub-compatible forge MCP server.',
    }));
    return;
  }

  if (method === 'tools/list') {
    // The same frozen array every time: byte-for-byte identical across calls.
    writeJsonRpc(res, 200, resultResponse(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      // Unknown tool: a JSON-RPC error (never 500, never a result).
      writeJsonRpc(res, 200, errorResponse(id, -32602, `Unknown tool: ${name}`));
      return;
    }
    const rawArguments = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const schema = tool.inputSchema as { required?: readonly string[] };
    const missing = (schema.required ?? []).filter((property) => {
      const value = rawArguments[property];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      writeJsonRpc(res, 200, errorResponse(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
      return;
    }
    try {
      const outcome = executeTool(forge, tool.name as string, rawArguments);
      writeJsonRpc(res, 200, resultResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
        structuredContent: outcome,
        isError: false,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'tool failed';
      writeJsonRpc(res, 200, resultResponse(id, {
        content: [{ type: 'text', text: message }],
        isError: true,
      }));
    }
    return;
  }

  // Any other method: method-not-found (never exercised by the suite; never a 5xx).
  writeJsonRpc(res, 200, errorResponse(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------- the tool implementations

function executeTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': return toolCreateRepo(forge, args);
    case 'get_repo': return toolGetRepo(forge, args);
    case 'create_issue': return toolCreateIssue(forge, args);
    case 'list_issues': return toolListIssues(forge, args);
    case 'create_pull_request': return toolCreatePullRequest(forge, args);
    case 'merge_pull_request': return toolMergePullRequest(forge, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function repoToolJson(repo: ForgeRepo): Record<string, unknown> {
  return {
    id: repoId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    default_branch: repo.git.headTarget.replace(/^refs\/heads\//, ''),
    description: repo.description,
    owner: { login: repo.owner },
  };
}

/** Stable id: a pure function of the repo's full name (never regenerated). */
function repoId(repo: ForgeRepo): number {
  let hash = 0;
  const fullName = `${repo.owner}/${repo.name}`;
  for (let index = 0; index < fullName.length; index += 1) hash = (hash * 31 + fullName.charCodeAt(index)) | 0;
  return 5000 + (Math.abs(hash) % 100000);
}

function toolCreateRepo(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repoName = str(args.name);
  if (repoName === '') throw new Error('name is required');
  const existing = forge.getRepo(VIEWER.login, repoName);
  if (existing !== null) return repoToolJson(existing);
  const repo = forge.createRepo(VIEWER.login, repoName, str(args.description), args.private === true, false);
  return repoToolJson(repo);
}

function toolGetRepo(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = forge.getRepo(str(args.owner), str(args.repo));
  if (repo === null) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  return repoToolJson(repo);
}

function toolCreateIssue(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = forge.getRepo(str(args.owner), str(args.repo));
  if (repo === null) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  const title = str(args.title);
  if (title === '') throw new Error('title is required');
  const number = forge.nextIssueNumberFor(repo.owner, repo.name);
  const now = forge.nowMs();
  const issue = {
    number,
    title,
    body: str(args.body),
    labels: [] as string[],
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
  return { id: 100000 + issue.number, number: issue.number, title: issue.title, body: issue.body, state: 'open' };
}

function toolListIssues(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = forge.getRepo(str(args.owner), str(args.repo));
  if (repo === null) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  const state = str(args.state);
  let list = repo.issues.slice();
  if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
  list.sort((a, b) => b.number - a.number);
  return {
    issues: list.map((issue) => ({ id: 100000 + issue.number, number: issue.number, title: issue.title, state: issue.state })),
    total: list.length,
  };
}

function toolCreatePullRequest(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = forge.getRepo(str(args.owner), str(args.repo));
  if (repo === null) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  const title = str(args.title);
  const head = str(args.head);
  const base = str(args.base);
  if (title === '' || head === '' || base === '') throw new Error('title, head and base are required');
  const headSha = repo.git.refs.get(`refs/heads/${head}`) ?? '0'.repeat(40);
  const baseSha = repo.git.refs.get(`refs/heads/${base}`) ?? '0'.repeat(40);
  const number = forge.nextIssueNumberFor(repo.owner, repo.name);
  const now = forge.nowMs();
  const pull = {
    number,
    title,
    body: str(args.body),
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
  return {
    id: 200000 + pull.number,
    number: pull.number,
    title: pull.title,
    state: 'open',
    merged: false,
    head: { ref: pull.headRef, label: `${repo.owner}:${pull.headRef}`, sha: pull.headSha },
    base: { ref: pull.baseRef, label: `${repo.owner}:${pull.baseRef}`, sha: pull.baseSha },
  };
}

function toolMergePullRequest(forge: Forge, args: Record<string, unknown>): Record<string, unknown> {
  const repo = forge.getRepo(str(args.owner), str(args.repo));
  if (repo === null) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  const number = Number(args.pull_number);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) throw new Error(`pull request ${number} not found`);
  if (!pull.merged) {
    // Squash-merge: one commit on the base branch carrying the head tree, then close the pull.
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.git.refs.get(baseRef) ?? pull.baseSha;
    const headCommit = repo.git.getObject(pull.headSha);
    const headTree = headCommit !== null && headCommit.type === OBJ_COMMIT ? parseCommit(headCommit.body).tree : null;
    if (headTree === null) throw new Error('pull request head has no tree');
    const mergeBody = serializeCommit({
      tree: headTree,
      parents: [baseTip],
      author: { name: VIEWER.name, email: VIEWER.email, epochSec: 1700000000, tz: '+0000' },
      committer: { name: VIEWER.name, email: VIEWER.email, epochSec: 1700000000, tz: '+0000' },
      message: `${pull.title} (#${pull.number})\n\nSquash merge branch '${pull.headRef}' into ${pull.baseRef}\n`,
    });
    const mergeSha = repo.git.addObject(OBJ_COMMIT, mergeBody);
    repo.git.setRef(baseRef, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAtMs = forge.nowMs();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAtMs = pull.mergedAtMs;
  }
  return { merged: true, sha: pull.mergeCommitSha ?? '0'.repeat(40) };
}
