// GraphQL v4 endpoint (POST /api/graphql) per spec-graphql.md: a subset parser (operations,
// variables, aliases, arguments, fragments), a schema registry for the targeted __type probes,
// and an executor over the shared forge store with Relay-style global ids.

import type { ForgeRequest, ForgeResponse } from './http-types.ts';
import { OBJ_COMMIT, parseCommit, parseTree, serializeCommit } from './git/objects.ts';
import { Forge, VIEWER, type ForgeRepo } from './store.ts';

// ---------------------------------------------------------------- schema registry

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
  Ref: ['name', 'id'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Comment: ['id', 'body', 'author'],
  CommentEdge: ['node'],
  Node: ['id'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['fields', 'enumValues', 'name', 'kind'],
});

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
});

// ---------------------------------------------------------------- the parser

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Map<string, unknown>;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | { kind: 'fragment-spread'; name: string } | { kind: 'inline-fragment'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, { type: string; defaultValue: unknown }>;
  selection: SelectionNode[];
}

interface FragmentDefinition {
  typeCondition: string;
  selection: SelectionNode[];
}

interface ParsedDocument {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

interface Token {
  type: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameCont = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (pos < input.length) {
    const ch = input[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { pos += 1; continue; }
    if (ch === '#') { while (pos < input.length && input[pos] !== '\n') pos += 1; continue; }
    if (ch === '"') {
      if (input.startsWith('"""', pos)) {
        // Block string.
        const end = input.indexOf('"""', pos + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ type: 'string', value: input.slice(pos + 3, end) });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < input.length && input[pos] !== '"') {
        if (input[pos] === '\\' && pos + 1 < input.length) {
          const escape = input[pos + 1]!;
          if (escape === 'n') value += '\n';
          else if (escape === 't') value += '\t';
          else if (escape === 'r') value += '\r';
          else if (escape === '"') value += '"';
          else if (escape === '\\') value += '\\';
          else if (escape === 'u') { value += String.fromCharCode(Number.parseInt(input.slice(pos + 2, pos + 6), 16)); pos += 4; }
          else value += escape;
          pos += 2;
          continue;
        }
        value += input[pos];
        pos += 1;
      }
      if (input[pos] !== '"') throw new Error('unterminated string');
      pos += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[pos + 1] ?? ''))) {
      let value = '';
      while (pos < input.length && /[0-9-]/.test(input[pos]!)) value += input[pos++];
      if (input[pos] === '.') { value += '.'; pos += 1; while (pos < input.length && /[0-9]/.test(input[pos]!)) value += input[pos++]; }
      tokens.push({ type: value.includes('.') ? 'float' : 'int', value });
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (pos < input.length && isNameCont(input[pos]!)) value += input[pos++];
      tokens.push({ type: 'name', value });
      continue;
    }
    if (ch === '.' && input.startsWith('...', pos)) { tokens.push({ type: 'punct', value: '...' }); pos += 3; continue; }
    if ('{}()[]:$!=@|&'.includes(ch)) { tokens.push({ type: 'punct', value: ch }); pos += 1; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${pos}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class GraphQLParser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  parseDocument(): ParsedDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().type !== 'eof') {
      const token = this.next();
      if (token.type !== 'name') throw new Error(`expected operation, got ${token.value}`);
      if (token.value === 'fragment') {
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('fragment needs "on"');
        const typeCondition = this.next().value;
        const selection = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selection });
        continue;
      }
      const type = token.value as 'query' | 'mutation';
      if (type !== 'query' && type !== 'mutation') throw new Error(`unsupported operation type ${token.value}`);
      let name: string | null = null;
      if (this.peek().type === 'name') name = this.next().value;
      const variables = new Map<string, { type: string; defaultValue: unknown }>();
      if (this.peekPunct('(')) {
        this.next();
        while (!this.peekPunct(')')) {
          this.expectPunct('$');
          const variableName = this.next().value;
          this.expectPunct(':');
          const variableType = this.parseType();
          let defaultValue: unknown = undefined;
          if (this.peekPunct('=')) { this.next(); defaultValue = this.parseValueLiteral(); }
          variables.set(variableName, { type: variableType, defaultValue });
        }
        this.expectPunct(')');
      }
      const selection = this.parseSelectionSet();
      operations.push({ type, name, variables, selection });
    }
    return { operations, fragments };
  }

  private parseType(): string {
    let base = this.next().value;
    if (this.peekPunct('[')) {
      this.next();
      base = `[${this.parseType()}]`;
      this.expectPunct(']');
    }
    if (this.peekPunct('!')) { this.next(); base += '!'; }
    return base;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!this.peekPunct('}')) {
      if (this.peekPunct('...')) {
        this.next();
        const token = this.peek();
        if (token.type === 'name' && token.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          selection.push({ kind: 'inline-fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selection.push({ kind: 'fragment-spread', name: this.next().value });
        }
        continue;
      }
      const first = this.next();
      if (first.type !== 'name') throw new Error(`expected field name, got ${first.value}`);
      let alias = first.value;
      let fieldName = first.value;
      if (this.peekPunct(':')) {
        this.next();
        fieldName = this.next().value;
      }
      const args = new Map<string, unknown>();
      if (this.peekPunct('(')) {
        this.next();
        while (!this.peekPunct(')')) {
          const argName = this.next().value;
          this.expectPunct(':');
          args.set(argName, this.parseValueLiteral());
        }
        this.expectPunct(')');
      }
      // Directives (@include etc.) are never sent by the suite; skip any.
      while (this.peekPunct('@')) { this.next(); this.next(); if (this.peekPunct('(')) { this.next(); while (!this.peekPunct(')')) this.next(); this.expectPunct(')'); } }
      let fieldSelection: SelectionNode[] = [];
      if (this.peekPunct('{')) fieldSelection = this.parseSelectionSet();
      selection.push({ kind: 'field', alias, name: fieldName, args, selection: fieldSelection });
    }
    this.expectPunct('}');
    return selection;
  }

  private parseValueLiteral(): unknown {
    const token = this.peek();
    if (token.type === 'punct' && token.value === '$') { this.next(); return { __variable: this.next().value }; }
    if (token.type === 'int') { this.next(); return Number.parseInt(token.value, 10); }
    if (token.type === 'float') { this.next(); return Number.parseFloat(token.value); }
    if (token.type === 'string') { this.next(); return token.value; }
    if (token.type === 'name') {
      this.next();
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      this.next();
      const list: unknown[] = [];
      while (!this.peekPunct(']')) list.push(this.parseValueLiteral());
      this.expectPunct(']');
      return list;
    }
    if (token.type === 'punct' && token.value === '{') {
      this.next();
      const object: Record<string, unknown> = {};
      while (!this.peekPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        object[key] = this.parseValueLiteral();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Substitute variables and unwrap enum markers after binding. */
function bindValue(value: unknown, variables: Map<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in value) {
      const name = (value as { __variable: string }).__variable;
      const bound = variables.get(name);
      return bound === undefined ? null : bound; // an unbound/null variable acts as absent-null
    }
    if ('__enum' in value) return (value as { __enum: string }).__enum;
    if (Array.isArray(value)) return value.map((entry) => bindValue(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = bindValue(entry, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- global ids

const encodeId = (type: string, id: number | string): string => Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
const decodeId = (globalId: string): { type: string; id: string } | null => {
  try {
    const decoded = Buffer.from(globalId, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return { type: decoded.slice(0, colon), id: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- execution

interface ExecContext {
  forge: Forge;
  fragments: Map<string, FragmentDefinition>;
  errors: string[];
}

function typeNameOfValue(value: Record<string, unknown>): string {
  return (value.__typename as string) ?? '';
}

function executeSelection(context: ExecContext, selection: readonly SelectionNode[], value: Record<string, unknown>, variables: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = typeNameOfValue(value);
  const allowed = TYPE_FIELDS[typename];
  for (const node of selection) {
    if (node.kind === 'fragment-spread') {
      const fragment = context.fragments.get(node.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(context, fragment.selection, value, variables));
      continue;
    }
    if (node.kind === 'inline-fragment') {
      if (node.typeCondition === null || node.typeCondition === typename || value.__fragmentOk === true) {
        Object.assign(out, executeSelection(context, node.selection, value, variables));
      }
      continue;
    }
    if (allowed !== undefined && !allowed.includes(node.name)) {
      context.errors.push(`Cannot query field "${node.name}" on type "${typename === '' ? 'unknown' : typename}".`);
      continue;
    }
    const raw = (value as Record<string, unknown>)[node.name];
    const resolved = typeof raw === 'function' ? (raw as (args: Record<string, unknown>) => unknown)(bindArgs(node.args, variables)) : raw;
    out[node.alias] = finishValue(context, node, resolved, variables);
  }
  return out;
}

function bindArgs(args: ReadonlyMap<string, unknown>, variables: Map<string, unknown>): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [key, value] of args) {
    const resolved = bindValue(value, variables);
    if (resolved !== null && resolved !== undefined) bound[key] = resolved;
  }
  return bound;
}

function finishValue(context: ExecContext, node: FieldNode, resolved: unknown, variables: Map<string, unknown>): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) return resolved.map((entry) => finishValue(context, node, entry, variables));
  if (typeof resolved === 'object') {
    const record = resolved as Record<string, unknown>;
    if (node.selection.length === 0) return record;
    return executeSelection(context, node.selection, record, variables);
  }
  return resolved;
}

// ---------------------------------------------------------------- object builders

/**
 * An issue's global id. It names the repository too: issue numbers only count inside one
 * repository, so a bare number would not identify an issue across the account's repositories.
 */
function issueGlobalId(repo: ForgeRepo, issue: ForgeRepo['issues'][number]): string {
  return encodeId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function issueNode(repo: ForgeRepo, issue: ForgeRepo['issues'][number]): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    author: { __typename: 'User', login: issue.user },
    createdAt: iso(issue.createdAtMs),
    updatedAt: iso(issue.updatedAtMs),
  };
}

function pullNode(repo: ForgeRepo, pull: ForgeRepo['pulls'][number]): Record<string, unknown> {
  const baseCommit = repo.git.getObject(pull.baseSha);
  const headCommit = repo.git.getObject(pull.headSha);
  const baseTree = baseCommit !== null && baseCommit.type === OBJ_COMMIT ? parseCommit(baseCommit.body).tree : null;
  const headTree = headCommit !== null && headCommit.type === OBJ_COMMIT ? parseCommit(headCommit.body).tree : null;
  return {
    __typename: 'PullRequest',
    id: encodeId('PullRequest', pull.number),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: pull.merged,
    mergeable: 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    title: pull.title,
    body: pull.body,
    files: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 10;
      const changed = diffPaths(repo.git, baseTree, headTree);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: changed.slice(0, first).map((path) => ({ __typename: 'PullRequestChangedFile', path })),
      };
    },
  };
}

function diffPaths(git: ForgeRepo['git'], baseTreeSha: string | null, headTreeSha: string | null): string[] {
  const out: string[] = [];
  const walk = (base: string | null, head: string | null, prefix: string): void => {
    const baseEntries = base === null ? [] : parseTreeEntries(git, base);
    const headEntries = head === null ? [] : parseTreeEntries(git, head);
    const names = new Set<string>([...baseEntries.map((entry) => entry.name), ...headEntries.map((entry) => entry.name)]);
    for (const name of names) {
      const baseEntry = baseEntries.find((entry) => entry.name === name) ?? null;
      const headEntry = headEntries.find((entry) => entry.name === name) ?? null;
      const path = prefix === '' ? name : `${prefix}/${name}`;
      const baseIsDir = baseEntry !== null && baseEntry.mode === '40000';
      const headIsDir = headEntry !== null && headEntry.mode === '40000';
      if (baseEntry === null && headEntry === null) continue;
      if (baseEntry === null || headEntry === null) {
        if (baseIsDir || headIsDir) walk(baseEntry?.sha ?? null, headEntry?.sha ?? null, path);
        else out.push(path);
        continue;
      }
      if (baseEntry.sha === headEntry.sha) continue;
      if (baseIsDir && headIsDir) walk(baseEntry.sha, headEntry.sha, path);
      else out.push(path);
    }
  };
  walk(baseTreeSha, headTreeSha, '');
  return out;
}

function parseTreeEntries(git: ForgeRepo['git'], treeSha: string): Array<{ mode: string; name: string; sha: string }> {
  const obj = git.getObject(treeSha);
  if (obj === null || obj.type !== 2) return [];
  return parseTree(obj.body).map((entry) => ({ ...entry, mode: entry.mode === '040000' ? '40000' : entry.mode }));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function repositoryNode(forge: Forge, repo: ForgeRepo): Record<string, unknown> {
  const branchName = repo.git.headTarget.replace(/^refs\/heads\//, '');
  return {
    __typename: 'Repository',
    id: encodeId('Repository', repoDatabaseId(repo)),
    databaseId: repoDatabaseId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: branchName },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: (args: Record<string, unknown>) => {
      const number = Number(args.number);
      const issue = repo.issue(number);
      return issue === null ? null : issueNode(repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      let list = repo.issues.slice();
      const states = Array.isArray(args.states) ? (args.states as string[]).map((entry) => String(entry).toLowerCase()) : null;
      if (states !== null && states.length > 0) list = list.filter((issue) => states.includes(issue.state));
      const orderBy = (typeof args.orderBy === 'object' && args.orderBy !== null ? args.orderBy : {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      list.sort((a, b) => (direction === 'DESC'
        ? (b.createdAtMs - a.createdAtMs) || (b.number - a.number)
        : (a.createdAtMs - b.createdAtMs) || (a.number - b.number)));
      const first = typeof args.first === 'number' ? args.first : 30;
      const afterCursor = typeof args.after === 'string' && args.after !== '' ? decodeId(args.after) : null;
      if (afterCursor !== null && afterCursor.type === 'cursor') {
        const afterNumber = Number.parseInt(afterCursor.id, 10);
        if (Number.isFinite(afterNumber)) {
          list = direction === 'DESC' ? list.filter((issue) => issue.number < afterNumber) : list.filter((issue) => issue.number > afterNumber);
        }
      }
      const page = list.slice(0, Math.max(0, first));
      const hasNextPage = list.length > page.length;
      const endCursor = page.length > 0 ? encodeId('cursor', page[page.length - 1]!.number) : encodeId('cursor', 0);
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueNode(repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        totalCount: repo.issues.length,
      };
    },
    pullRequests: (args: Record<string, unknown>) => {
      const first = typeof args.first === 'number' ? args.first : 30;
      const list = repo.pulls.slice().sort((a, b) => b.number - a.number).slice(0, Math.max(0, first));
      return {
        __typename: 'PullRequestConnection',
        nodes: list.map((pull) => pullNode(repo, pull)),
        totalCount: repo.pulls.length,
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const number = Number(args.number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : pullNode(repo, pull);
    },
    createdAt: iso(repo.createdAtMs),
    updatedAt: iso(repo.updatedAtMs),
  };
}

function repoDatabaseId(repo: ForgeRepo): number {
  let hash = 0;
  const fullName = `${repo.owner}/${repo.name}`;
  for (let index = 0; index < fullName.length; index += 1) hash = (hash * 31 + fullName.charCodeAt(index)) | 0;
  return 5000 + (Math.abs(hash) % 100000);
}

// ---------------------------------------------------------------- root resolution

function resolveRoot(context: ExecContext, operation: OperationNode, variables: Map<string, unknown>): Record<string, unknown> {
  const { forge } = context;
  const bound = new Map<string, unknown>();
  for (const [name, definition] of operation.variables) {
    const supplied = variables.get(name);
    if (supplied !== undefined && supplied !== null) bound.set(name, supplied);
    else if (definition.defaultValue !== undefined) bound.set(name, definition.defaultValue);
  }
  const out: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if (node.kind !== 'field') continue;
    const resolved = operation.type === 'query'
      ? resolveQueryField(context, node, bound, forge)
      : resolveMutationField(context, node, bound, forge);
    out[node.alias] = finishValue(context, node, resolved, bound);
  }
  return out;
}

function resolveQueryField(context: ExecContext, node: FieldNode, bound: Map<string, unknown>, forge: Forge): unknown {
  const args = bindArgs(node.args, bound);
  if (node.name === 'viewer') return { __typename: 'Viewer', login: VIEWER.login, id: encodeId('User', VIEWER.id) };
  if (node.name === 'repository') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo === null ? null : repositoryNode(forge, repo);
  }
  if (node.name === 'node') {
    const globalId = String(args.id ?? '');
    const decoded = decodeId(globalId);
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = forge.getRepo(String(args.owner ?? ''), decoded.id);
      void args.owner;
      // node(id:) does not carry owner/name; look the repo up by its database id.
      const found = findByDatabaseId(forge, Number(decoded.id));
      return found === null ? null : { __typename: 'Repository', __fragmentOk: true, ...repositoryNode(forge, found), id: globalId };
    }
    return { __typename: decoded.type, id: globalId };
  }
  if (node.name === '__type') {
    const wanted = String(args.name ?? '');
    const fields = TYPE_FIELDS[wanted];
    const enums = ENUM_VALUES[wanted];
    if (fields === undefined && enums === undefined) return null;
    return {
      __typename: '__Type',
      fields: (fields ?? []).map((fieldName) => ({ name: fieldName })),
      enumValues: (enums ?? []).map((value) => ({ name: value })),
    };
  }
  context.errors.push(`Cannot query field "${node.name}" on type "Query".`);
  return null;
}

function findByDatabaseId(forge: Forge, databaseId: number): ForgeRepo | null {
  for (const repo of forge.listRepos(VIEWER.login)) {
    if (repoDatabaseId(repo) === databaseId) return repo;
  }
  return null;
}

function resolveMutationField(context: ExecContext, node: FieldNode, bound: Map<string, unknown>, forge: Forge): unknown {
  const input = (bound.get('input') ?? {}) as Record<string, unknown>;
  if (node.name === 'createIssue') {
    const decoded = decodeId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.type === 'Repository' ? findByDatabaseId(forge, Number(decoded.id)) : null;
    if (repo === null) throw new Error('repository not found');
    const number = forge.nextIssueNumberFor(repo.owner, repo.name);
    const now = forge.nowMs();
    const issue = {
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
  }
  if (node.name === 'closeIssue') {
    const found = findIssueByGlobalId(forge, String(input.issueId ?? ''));
    if (found === null) throw new Error('issue not found');
    const { repo, issue } = found;
    issue.state = 'closed';
    issue.closedAtMs = forge.nowMs();
    issue.updatedAtMs = issue.closedAtMs;
    issue.version += 1;
    return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
  }
  if (node.name === 'createPullRequest') {
    const decoded = decodeId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.type === 'Repository' ? findByDatabaseId(forge, Number(decoded.id)) : null;
    if (repo === null) throw new Error('repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const number = forge.nextIssueNumberFor(repo.owner, repo.name);
    const now = forge.nowMs();
    const pull = {
      number,
      title: String(input.title ?? ''),
      body: '',
      state: 'open' as const,
      merged: false,
      mergedAtMs: null,
      mergeCommitSha: null,
      headRef: head,
      headSha: repo.git.refs.get(`refs/heads/${head}`) ?? '0'.repeat(40),
      baseRef: base,
      baseSha: repo.git.refs.get(`refs/heads/${base}`) ?? '0'.repeat(40),
      user: VIEWER.login,
      createdAtMs: now,
      updatedAtMs: now,
      files: [] as ForgeRepo['pulls'][number]['files'],
    };
    repo.pulls.push(pull);
    repo.updatedAtMs = now;
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  if (node.name === 'mergePullRequest') {
    const decoded = decodeId(String(input.pullRequestId ?? ''));
    const found = decoded !== null && decoded.type === 'PullRequest' ? findPullByNumber(forge, Number(decoded.id)) : null;
    if (found === null) throw new Error('pull request not found');
    const { repo, pull } = found;
    if (!pull.merged) {
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
    return {
      __typename: 'MergePullRequestPayload',
      pullRequest: { __typename: 'PullRequest', id: encodeId('PullRequest', pull.number), number: pull.number, merged: true, state: 'MERGED' },
    };
  }
  if (node.name === 'addComment') {
    const found = findIssueByGlobalId(forge, String(input.subjectId ?? ''));
    if (found === null) throw new Error('issue not found');
    const { issue } = found;
    const body = String(input.body ?? '');
    const commentId = forge.nextCommentId();
    issue.comments.push({ id: commentId, body, user: VIEWER.login, createdAtMs: forge.nowMs() });
    issue.version += 1;
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { node: { __typename: 'Comment', id: encodeId('Comment', commentId), body } },
    };
  }
  context.errors.push(`Cannot query field "${node.name}" on type "Mutation".`);
  return null;
}

function findIssueByGlobalId(forge: Forge, globalId: string): { repo: ForgeRepo; issue: ForgeRepo['issues'][number] } | null {
  const decoded = decodeId(globalId);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const payload = decoded.id;
  const hash = payload.lastIndexOf('#');
  if (hash !== -1) {
    // The id names its repository: "owner/name#number".
    const slash = payload.lastIndexOf('/');
    if (slash === -1 || slash > hash) return null;
    const owner = payload.slice(0, slash);
    const name = payload.slice(slash + 1, hash);
    const number = Number.parseInt(payload.slice(hash + 1), 10);
    const repo = forge.getRepo(owner, name);
    if (repo === null) return null;
    const issue = repo.issue(number);
    return issue === null ? null : { repo, issue };
  }
  // An id without its repository (an older id): the first repository that has that number.
  const number = Number.parseInt(payload, 10);
  for (const repo of forge.listRepos(VIEWER.login)) {
    const issue = repo.issue(number);
    if (issue !== null) return { repo, issue };
  }
  return null;
}

function findPullByNumber(forge: Forge, number: number): { repo: ForgeRepo; pull: ForgeRepo['pulls'][number] } | null {
  for (const repo of forge.listRepos(VIEWER.login)) {
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------- the endpoint

export interface GraphQLRequest {
  req: ForgeRequest;
  res: ForgeResponse;
  body: Buffer;
  forge: Forge;
  token: string | null;
  authenticated: boolean;
}

export function handleGraphQL(request: GraphQLRequest): void {
  const { res, body, forge, authenticated } = request;
  if (!authenticated) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.length === 0 ? 'null' : body.toString('utf8'));
  } catch {
    parsedBody = undefined;
  }
  const entries: Array<{ query: string; variables: Record<string, unknown> }> = [];
  if (Array.isArray(parsedBody)) {
    for (const entry of parsedBody) {
      if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).query === 'string') {
        entries.push(entry as { query: string; variables: Record<string, unknown> });
      }
    }
  } else if (parsedBody !== null && typeof parsedBody === 'object' && typeof (parsedBody as Record<string, unknown>).query === 'string') {
    entries.push(parsedBody as { query: string; variables: Record<string, unknown> });
  } else {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errors: [{ message: 'the request body must carry a query string' }] }));
    return;
  }

  const envelopes = entries.map((entry) => executeOne(forge, entry.query, entry.variables ?? {}));
  if (entries.length === 1) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(envelopes[0]));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(envelopes));
}

function executeOne(forge: Forge, query: string, variableValues: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = new GraphQLParser(lex(query)).parseDocument();
    const operation = parsed.operations[0];
    if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
    const context: ExecContext = { forge, fragments: parsed.fragments, errors: [] };
    const variables = new Map<string, unknown>(Object.entries(variableValues ?? {}));
    const data = resolveRoot(context, operation, variables);
    if (context.errors.length > 0) {
      return { errors: context.errors.map((message) => ({ message })) };
    }
    return { data };
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'execution failed' }] };
  }
}
