// The forge's state: users, repositories (each with its GitState and issue/PR/label data), and
// the token -> viewer mapping. Everything is in memory; ids and timestamps are deterministic.

import { GitState } from './git/protocol.ts';

/** The scenario identities (wire.ts, SCENARIO_SEED 6a09e667f3bcc909) — fixed for this competition. */
export const VIEWER = Object.freeze({ id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' });
export const TEAMMATE = Object.freeze({ id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' });
export const STRANGER = Object.freeze({ id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' });
export const ORG_LOGIN = 'faint-meadow-org';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  createdAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  user: string;
  comments: Array<{ id: number; body: string; user: string; createdAtMs: number }>;
  /** Bumped on every change to the issue; the REST surface caches its JSON against it. */
  version: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtMs: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAtMs: number;
  updatedAtMs: number;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string; previousFilename?: string }>;
}

export interface ContentsEntry {
  path: string;
  sha: string; // blob sha
  contentBase64: string;
  size: number;
  commitSha: string;
}

export class ForgeRepo {
  readonly name: string;
  readonly owner: string;
  readonly git = new GitState();
  readonly issues: Issue[] = [];
  /** Issue numbers -> issue; the array above keeps creation order, this one answers lookups in O(1). */
  readonly issuesByNumber = new Map<number, Issue>();
  readonly pulls: PullRequest[] = [];
  readonly labels = new Set<string>();
  readonly contents = new Map<string, ContentsEntry>();
  description: string;
  isPrivate: boolean;
  autoInit: boolean;
  readonly createdAtMs: number;
  updatedAtMs: number;
  deleted = false;

  constructor(name: string, owner: string, description: string, isPrivate: boolean, autoInit: boolean, createdAtMs: number) {
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.autoInit = autoInit;
    this.createdAtMs = createdAtMs;
    this.updatedAtMs = createdAtMs;
  }

  /** Add an issue to both indexes. */
  addIssue(issue: Issue): void {
    this.issues.push(issue);
    this.issuesByNumber.set(issue.number, issue);
  }

  /** The issue with that number, or null. */
  issue(number: number): Issue | null {
    return this.issuesByNumber.get(number) ?? null;
  }
}

export class Forge {
  /** Keyed by `${owner}/${name}` lowercased only by exact name (GitHub names are case-insensitive-ish; suite uses one case). */
  private readonly repos = new Map<string, ForgeRepo>();
  /** Deterministic clock: starts at the trial's opening time, +1s per state change. */
  private clockMs: number;
  private nextRepoId = 5000;
  private nextIssueNumber = new Map<string, number>();

  constructor(trialNowIso: string | undefined) {
    const base = trialNowIso !== undefined && trialNowIso !== '' ? Date.parse(trialNowIso) : 0;
    this.clockMs = Number.isFinite(base) ? base : 0;
  }

  nowMs(): number {
    this.clockMs += 1000;
    return this.clockMs;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  getRepo(owner: string, name: string): ForgeRepo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, autoInit: boolean): ForgeRepo {
    const repo = new ForgeRepo(name, owner, description, isPrivate, autoInit, this.nowMs());
    this.repos.set(`${owner}/${name}`, repo);
    this.nextIssueNumber.set(`${owner}/${name}`, 1);
    void this.nextRepoId;
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner: string): ForgeRepo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner && !repo.deleted);
  }

  nextIssueNumberFor(owner: string, name: string): number {
    const key = `${owner}/${name}`;
    const next = this.nextIssueNumber.get(key) ?? 1;
    this.nextIssueNumber.set(key, next + 1);
    return next;
  }

  private commentIdCounter = 1000;

  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }
}
