// The git object model: hashing, loose in-memory storage, and (de)serialization of the four
// object types. All hashes are SHA-1 (the suite's object-format), all compression native zlib
// for writing and the custom inflate for reading packs.

import { createHash } from 'node:crypto';

export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;

export type ObjTypeName = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_BY_NAME: Readonly<Record<ObjTypeName, number>> = Object.freeze({
  commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG,
});
export const NAME_BY_TYPE: Readonly<Record<number, ObjTypeName>> = Object.freeze({
  [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag',
});

export function typeName(type: number): ObjTypeName {
  const name = NAME_BY_TYPE[type];
  if (name === undefined) throw new Error(`unknown object type ${type}`);
  return name;
}

/** The SHA-1 of an object, as git computes it: `<type> <size>\0<content>`. */
export function objectSha(type: number, content: Buffer): string {
  const header = Buffer.from(`${typeName(type)} ${content.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(content).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. '100644', '100755', '40000' (no leading zero, as git writes it), '120000'
  name: string;
  sha: string; // 40 hex chars
}

/** Parse a tree object's payload into entries. */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode/name separator');
    const mode = content.toString('ascii', off, sp);
    const nul = content.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > content.length) throw new Error('tree entry has no sha terminator');
    const name = content.toString('utf8', sp + 1, nul);
    const sha = content.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (mode without leading zeros, as git writes them). */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const sha = Buffer.from(entry.sha, 'hex');
    if (sha.length !== 20) throw new Error(`tree entry sha must be 20 bytes: ${entry.sha}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), sha);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface Signature {
  name: string;
  email: string;
  epochSec: number;
  tz: string; // e.g. '+0000'
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  headers: ReadonlyArray<readonly [string, string]>; // every other header, in order (gpgsig may be multi-line)
  message: string;
}

export function parseSignature(value: string): Signature {
  // `Name <email> 1700000000 +0000`
  const lt = value.lastIndexOf(' <');
  const gt = value.indexOf('> ', lt);
  if (lt < 0 || gt < 0) throw new Error(`bad signature line: ${JSON.stringify(value)}`);
  const name = value.slice(0, lt);
  const email = value.slice(lt + 2, gt);
  const rest = value.slice(gt + 2).trim();
  const m = /^(-?\d+)\s+([+-]\d{4})$/.exec(rest);
  if (m === null) throw new Error(`bad signature timestamp: ${JSON.stringify(rest)}`);
  return { name, email, epochSec: Number(m[1]), tz: m[2]! };
}

export function serializeSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.epochSec} ${sig.tz}`;
}

export function parseCommit(content: Buffer): ParsedCommit {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const headText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Signature | null = null;
  let committer: Signature | null = null;
  const headers: Array<readonly [string, string]> = [];
  let currentKey = '';
  let currentValue = '';
  const flush = (): void => {
    if (currentKey === '') return;
    if (currentKey === 'tree') tree = currentValue;
    else if (currentKey === 'parent') parents.push(currentValue);
    else if (currentKey === 'author') author = parseSignature(currentValue);
    else if (currentKey === 'committer') committer = parseSignature(currentValue);
    else headers.push([currentKey, currentValue] as const);
    currentKey = '';
    currentValue = '';
  };
  for (const line of headText.split('\n')) {
    if (line.startsWith(' ')) {
      // continuation (gpgsig)
      currentValue += '\n' + line.slice(1);
      continue;
    }
    flush();
    const sp = line.indexOf(' ');
    if (sp < 0) { currentKey = line; currentValue = ''; continue; }
    currentKey = line.slice(0, sp);
    currentValue = line.slice(sp + 1);
  }
  flush();
  if (tree === '' || author === null || committer === null) throw new Error('commit is missing tree/author/committer');
  return { tree, parents, author, committer, headers, message };
}

export function serializeCommit(commit: {
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  message: string;
}): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${serializeSignature(commit.author)}`);
  lines.push(`committer ${serializeSignature(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

// ---------------------------------------------------------------- tags

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: Signature | null;
  message: string;
}

export function parseTag(content: Buffer): ParsedTag {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const headText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger: Signature | null = null;
  for (const line of headText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = parseSignature(value);
  }
  if (object === '' || type === '' || tag === '') throw new Error('tag is missing object/type/tag');
  return { object, type, tag, tagger, message };
}

export function serializeTag(parsed: {
  object: string;
  type: string;
  tag: string;
  tagger: Signature | null;
  message: string;
}): Buffer {
  const lines = [`object ${parsed.object}`, `type ${parsed.type}`, `tag ${parsed.tag}`];
  if (parsed.tagger !== null) lines.push(`tagger ${serializeSignature(parsed.tagger)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parsed.message}`, 'utf8');
}

// ---------------------------------------------------------------- the store

/** An in-memory object database: sha -> (type, content). The whole trial lives in memory. */
export class ObjectStore {
  private readonly objects = new Map<string, { type: number; content: Buffer }>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): { type: number; content: Buffer } | null {
    return this.objects.get(sha) ?? null;
  }

  typeOf(sha: string): number | null {
    return this.objects.get(sha)?.type ?? null;
  }

  /** Store an object under its own sha and return that sha. */
  add(type: number, content: Buffer): string {
    const sha = objectSha(type, content);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, content });
    return sha;
  }

  /** Store under a caller-supplied sha (as receive-pack does: the client dictates the sha). */
  addWithSha(sha: string, type: number, content: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, content });
  }

  size(): number {
    return this.objects.size;
  }
}

/** Peel a tag chain down to its non-tag object. Returns the final sha and its type. */
export function peel(store: ObjectStore, sha: string): { sha: string; type: number } {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = store.get(current);
    if (obj === null) return { sha: current, type: -1 };
    if (obj.type !== OBJ_TAG) return { sha: current, type: obj.type };
    const parsed = parseTag(obj.content);
    current = parsed.object;
  }
  throw new Error(`tag chain too deep at ${sha}`);
}
