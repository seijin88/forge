// The git smart-HTTP protocol handlers: ref advertisements (v2 + v0), ls-refs, fetch (v2 + v0)
// with shallow/deepen math, and receive-pack with report-status. Built to the suite's client
// (spec-git.md): sideband band 1 only, never pkt-line 0002, self-contained packs, lowercase oids.

import { createHash } from 'node:crypto';
import {
  OBJ_COMMIT, OBJ_TAG, OBJ_TREE, parseCommit, parseTag,
} from './objects.ts';
import { buildPack, parsePack } from './pack.ts';
import { decodePktLines, encodePktLine, flushPkt } from './pkt.ts';

export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'refs/heads/main';
const AGENT = 'agent=forge/1';

// ---------------------------------------------------------------- the repository's git side

/** Everything git about one repository, in memory for the trial's lifetime. */
export class GitState {
  readonly objects = new Map<string, { type: number; body: Buffer }>();
  readonly refs = new Map<string, string>();
  readonly headTarget = DEFAULT_BRANCH;
  /** Bumped on every ref/object change; keys the pack cache. */
  version = 0;
  private readonly packCache = new Map<string, Buffer>();

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  getObject(oid: string): { type: number; body: Buffer } | null {
    return this.objects.get(oid) ?? null;
  }

  addObject(type: number, body: Buffer): string {
    const hash = createSha1(type, body);
    if (!this.objects.has(hash)) {
      this.objects.set(hash, { type, body });
      this.version += 1;
    }
    return hash;
  }

  addObjectWithSha(oid: string, type: number, body: Buffer): void {
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, body });
      this.version += 1;
    }
  }

  setRef(name: string, oid: string): void {
    if (oid === ZERO_OID) this.refs.delete(name);
    else this.refs.set(name, oid);
    this.version += 1;
  }

  /** All refs (excluding HEAD), sorted; HEAD resolves iff its target exists. */
  listRefs(): Array<{ name: string; oid: string }> {
    const names = [...this.refs.keys()].sort();
    return names.map((name) => ({ name, oid: this.refs.get(name)! }));
  }

  headOid(): string | null {
    return this.refs.get(this.headTarget) ?? null;
  }

  /** A cached pack for an identical fetch (same wants/depth/store version). */
  cachedPack(key: string): Buffer | null {
    return this.packCache.get(key) ?? null;
  }

  putPack(key: string, pack: Buffer): void {
    if (this.packCache.size >= 6) this.packCache.clear();
    this.packCache.set(key, pack);
  }
}

function createSha1(type: number, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${typeNameOf(type)} ${body.length}\0`, 'ascii'));
  hash.update(body);
  return hash.digest('hex');
}

function typeNameOf(type: number): string {
  if (type === 1) return 'commit';
  if (type === 2) return 'tree';
  if (type === 3) return 'blob';
  if (type === 4) return 'tag';
  throw new Error(`unknown object type ${type}`);
}

// ---------------------------------------------------------------- reachability

export interface WalkResult {
  send: Set<string>;
  newBoundaries: string[];
  unshallowed: string[];
}

/**
 * Reachability closure: commit -> tree + parents; tag -> target; tree -> entries (skip gitlinks,
 * recurse dirs); blob -> nothing. `depth` (when finite) counts commits from the wants: the want is
 * depth 1, each parent adds 1. The walk runs through possessed commits (a deepen must reach past
 * them); the caller subtracts `possessed` afterwards. Boundary = a delivered commit at the cutoff
 * whose parents are not delivered.
 */
function walkClosure(
  git: GitState,
  roots: readonly string[],
  depth: number | null,
  clientBoundaries: ReadonlySet<string>,
  possessed: ReadonlySet<string>,
): WalkResult {
  void clientBoundaries;
  const deliverable = new Set<string>();
  const cutoffBoundaries: string[] = [];
  const commitQueue: Array<{ oid: string; level: number }> = [];
  const seenCommits = new Set<string>();

  const addTreeClosure = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (deliverable.has(current)) continue;
      const obj = git.getObject(current);
      if (obj === null) continue; // unknown objects are skipped; the store should have them
      deliverable.add(current);
      if (obj.type === OBJ_TREE) {
        for (const entry of parseTreeEntries(obj.body)) {
          if (entry.mode === '160000') continue; // gitlink: object is not in this store
          stack.push(entry.sha);
        }
      }
    }
  };

  for (const root of roots) {
    const obj = git.getObject(root);
    if (obj === null) continue;
    if (obj.type === OBJ_COMMIT) {
      if (!seenCommits.has(root)) {
        seenCommits.add(root);
        commitQueue.push({ oid: root, level: 1 });
      }
    } else {
      deliverable.add(root);
      if (obj.type === OBJ_TAG) {
        const tag = parseTag(obj.body);
        const target = git.getObject(tag.object);
        if (target !== null && target.type === OBJ_COMMIT) {
          if (!seenCommits.has(tag.object)) {
            seenCommits.add(tag.object);
            commitQueue.push({ oid: tag.object, level: 1 });
          }
        } else if (target !== null) {
          addTreeClosure(tag.object);
        }
      } else if (obj.type === OBJ_TREE) {
        addTreeClosure(root);
      }
    }
  }

  // Breadth-first over commits by generation level; trees/blobs ride with every visited commit.
  // seenCommits was already marked at enqueue time, so no re-check here — processing is unconditional.
  let head = 0;
  while (head < commitQueue.length) {
    const { oid, level } = commitQueue[head++];
    const obj = git.getObject(oid);
    if (obj === null) continue;
    deliverable.add(oid);
    const commit = parseCommit(obj.body);
    addTreeClosure(commit.tree);
    const withinDepth = depth === null || level < depth;
    if (withinDepth) {
      for (const parent of commit.parents) {
        if (!seenCommits.has(parent)) commitQueue.push({ oid: parent, level: level + 1 });
      }
    }
    if (depth !== null && level >= depth && commit.parents.length > 0) cutoffBoundaries.push(oid);
  }

  // Subtract possession; only delivered commits are reported as new boundaries.
  const send = new Set<string>();
  for (const oid of deliverable) {
    if (!possessed.has(oid)) send.add(oid);
  }
  const newBoundaries = cutoffBoundaries.filter((oid) => send.has(oid));
  const unshallowed: string[] = [];
  for (const boundary of clientBoundaries) {
    if (newBoundaries.includes(boundary)) continue;
    const obj = git.getObject(boundary);
    if (obj === null || obj.type !== OBJ_COMMIT) continue;
    if (parseCommit(obj.body).parents.some((parent) => send.has(parent))) unshallowed.push(boundary);
  }
  return { send, newBoundaries, unshallowed };
}

/** The client's possession set: closure of its haves, with ancestor edges cut at its boundaries. */
function walkPossessed(git: GitState, haves: readonly string[], boundaries: ReadonlySet<string>): Set<string> {
  const possessed = new Set<string>();
  const commitQueue: string[] = [];

  const addTreeClosure = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (possessed.has(current)) continue;
      const obj = git.getObject(current);
      if (obj === null) continue;
      possessed.add(current);
      if (obj.type === OBJ_TREE) {
        for (const entry of parseTreeEntries(obj.body)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.sha);
        }
      }
    }
  };

  /** Mark a commit (or any object) possessed, with its full tree/blob closure. */
  const addWithClosure = (oid: string): void => {
    if (possessed.has(oid)) return;
    const obj = git.getObject(oid);
    if (obj === null) return;
    possessed.add(oid);
    if (obj.type === OBJ_COMMIT) {
      addTreeClosure(parseCommit(obj.body).tree);
      commitQueue.push(oid);
    } else {
      addTreeClosure(oid);
    }
  };

  for (const have of haves) addWithClosure(have);
  let head = 0;
  while (head < commitQueue.length) {
    const oid = commitQueue[head++];
    if (boundaries.has(oid)) continue; // the boundary's ancestors are NOT possessed
    const obj = git.getObject(oid);
    if (obj === null || obj.type !== OBJ_COMMIT) continue;
    for (const parent of parseCommit(obj.body).parents) addWithClosure(parent);
  }
  return possessed;
}

function parseTreeEntries(body: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    const nul = body.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) break;
    entries.push({
      mode: body.toString('ascii', off, sp),
      name: body.toString('utf8', sp + 1, nul),
      sha: body.toString('hex', nul + 1, nul + 21),
    });
    off = nul + 21;
  }
  return entries;
}

/** Fast-forward test: walk parents from `newOid`; reaching `oldOid` proves descent. */
export function isDescendant(git: GitState, newOid: string, oldOid: string): boolean {
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === oldOid) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = git.getObject(current);
    if (obj === null || obj.type !== OBJ_COMMIT) continue;
    for (const parent of parseCommit(obj.body).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- sideband + response helpers

/** Sideband-mux `data` into band-1 packets (max 65515 data bytes each). */
export function sidebandMux(band: number, data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), data.subarray(off, Math.min(off + CHUNK, data.length))])));
  }
  if (data.length === 0) chunks.push(encodePktLine(Buffer.from([band])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- advertisements

export function infoRefsUploadV2(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine(`${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

function refListing(git: GitState): Array<{ name: string; oid: string; peeled: string | null }> {
  const listing: Array<{ name: string; oid: string; peeled: string | null }> = [];
  const head = git.headOid();
  if (head !== null) listing.push({ name: 'HEAD', oid: head, peeled: null });
  for (const ref of git.listRefs()) {
    const obj = git.getObject(ref.oid);
    const peeled = obj !== null && obj.type === OBJ_TAG ? peelWithGit(git, ref.oid) : null;
    listing.push({ name: ref.name, oid: ref.oid, peeled });
  }
  return listing;
}

export function infoRefsUploadV0(git: GitState): Buffer {
  const caps = ['side-band-64k', 'thin-pack', 'no-progress', 'ofs-delta', 'shallow', `symref=HEAD:${git.headTarget}`, AGENT];
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), flushPkt()];
  const refs = refListing(git);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
      if (ref.peeled !== null) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

export function infoRefsReceive(git: GitState): Buffer {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', AGENT];
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), flushPkt()];
  const refs = refListing(git);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function handleLsRefs(git: GitState, argLines: readonly string[]): Buffer {
  let peelRequested = true;
  let symrefs = true;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peelRequested = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const head = git.headOid();
  const emitRef = (name: string, oid: string, peeled: string | null): void => {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) return;
    let line = `${oid} ${name}`;
    if (symrefs && name === 'HEAD') line += ` symref-target:${git.headTarget}`;
    if (peelRequested && peeled !== null) line += ` peeled:${peeled}`;
    parts.push(encodePktLine(`${line}\n`));
  };
  if (head === null) {
    if (unborn) {
      if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
        let line = 'unborn HEAD';
        if (symrefs) line += ` symref-target:${git.headTarget}`;
        parts.push(encodePktLine(`${line}\n`));
      }
    }
  } else {
    emitRef('HEAD', head, null);
  }
  for (const ref of git.listRefs()) {
    const obj = git.getObject(ref.oid);
    let peeled: string | null = null;
    if (peelRequested && obj !== null && obj.type === OBJ_TAG) peeled = peelWithGit(git, ref.oid);
    emitRef(ref.name, ref.oid, peeled);
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function peelWithGit(git: GitState, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = git.getObject(current);
    if (obj === null || obj.type !== OBJ_TAG) return current;
    current = parseTag(obj.body).object;
  }
  return current;
}

// ---------------------------------------------------------------- fetch (v2 + v0)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function computeFetchUnused(): void {}

export function handleFetchV2(git: GitState, argLines: readonly string[]): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of argLines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const clientBoundaries = new Set(request.shallow);
  const possessed = walkPossessed(git, request.haves, clientBoundaries);
  const { send, newBoundaries, unshallowed } = walkClosure(git, request.wants, request.depth, clientBoundaries, possessed);
  if (process.env.FORGE_DEBUG === '1') {
    console.error(`[fetch-v2] wants=${JSON.stringify(request.wants)} inStore=${request.wants.map((w) => git.hasObject(w))} send=${send.size} stored=${git.objects.size}`);
  }

  const parts: Buffer[] = [];
  // acknowledgments (optional but for git fidelity)
  parts.push(encodePktLine('acknowledgments\n'));
  const common = request.haves.filter((have) => git.hasObject(have));
  if (common.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  parts.push(flushPkt());

  const packKey = `v2|d${request.depth === null ? 'x' : request.depth}|${[...request.wants].sort().join(',')}|${[...request.shallow].sort().join(',')}|${git.version}`;
  if (send.size === 0 && newBoundaries.length === 0 && unshallowed.length === 0) {
    git.putPack(packKey, Buffer.alloc(0));
    return Buffer.concat(parts); // acknowledgments only: nothing to send
  }
  if (newBoundaries.length > 0 || unshallowed.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of newBoundaries) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallowed) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(flushPkt());
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = cachedPackFor(git, packKey, send);
  parts.push(sidebandMux(1, pack));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

export function handleFetchV0(git: GitState, body: Buffer): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 1;
  for (const pkt of decodePktLines(body)) {
    if (pkt.kind === 'flush') { section = 2; continue; }
    if (pkt.kind !== 'data') continue;
    const line = pkt.data!.toString('utf8').replace(/\n$/, '');
    if (section === 1) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      // 'done' ends negotiation; anything else is ignored
    }
  }
  const clientBoundaries = new Set(request.shallow);
  const possessed = walkPossessed(git, request.haves, clientBoundaries);
  const { send, newBoundaries, unshallowed } = walkClosure(git, request.wants, request.depth, clientBoundaries, possessed);

  const parts: Buffer[] = [];
  for (const oid of newBoundaries) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallowed) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const common = request.haves.filter((have) => git.hasObject(have));
  if (common.length === 0) parts.push(encodePktLine('NAK\n'));
  else parts.push(encodePktLine(`ACK ${common[common.length - 1]!}\n`));
  if (send.size > 0) {
    const packKey = `v0|d${request.depth === null ? 'x' : request.depth}|${[...request.wants].sort().join(',')}|${[...request.shallow].sort().join(',')}|${git.version}`;
    parts.push(sidebandMux(1, cachedPackFor(git, packKey, send)));
  }
  return Buffer.concat(parts);
}

function cachedPackFor(git: GitState, key: string, send: ReadonlySet<string>): Buffer {
  const cached = git.cachedPack(key);
  if (cached !== null) return cached;
  const entries: Array<{ type: number; content: Buffer }> = [];
  const seen = new Set<string>();
  for (const oid of send) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = git.getObject(oid);
    if (obj !== null) entries.push({ type: obj.type, content: obj.body });
  }
  const pack = buildPack(entries);
  git.putPack(key, pack);
  return pack;
}

// ---------------------------------------------------------------- receive-pack (push)

export interface PushReport {
  unpackOk: boolean;
  lines: string[];
}

export function handleReceivePack(git: GitState, body: Buffer): Buffer {
  let report: PushReport;
  try {
    report = processPush(git, body);
  } catch (error) {
    report = { unpackOk: false, lines: [`unpack ${(error as Error).message}\n`] };
  }
  const reportLines = [report.unpackOk ? 'unpack ok\n' : report.lines[0]!, ...report.lines.slice(1)];
  const reportBody = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), flushPkt()]);
  return sidebandMux(1, reportBody);
}

function processPush(git: GitState, body: Buffer): PushReport {
  const lines: string[] = [];
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let off = 0;
  let sawFlush = false;
  while (off < body.length) {
    const hex = body.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line in command list');
    const len = Number.parseInt(hex, 16);
    if (len === 0) { off += 4; sawFlush = true; break; }
    if (len < 4 || off + len > body.length) throw new Error('truncated command pkt-line');
    const payload = body.toString('utf8', off + 4, off + len).replace(/\n$/, '');
    off += len;
    const nul = payload.indexOf('\0');
    const commandLine = nul >= 0 ? payload.slice(0, nul) : payload;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(commandLine);
    if (match === null) throw new Error(`bad push command: ${JSON.stringify(commandLine)}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (!sawFlush && commands.length === 0) throw new Error('push body has no commands');
  const packBytes = sawFlush ? body.subarray(off) : Buffer.alloc(0);

  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      unpackInto(git, packBytes);
    } catch (error) {
      unpackOk = false;
      lines.push(`unpack ${(error as Error).message}\n`);
    }
  }
  if (unpackOk) lines.push('unpack ok\n');

  for (const command of commands) {
    const current = git.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current !== undefined && current === command.oldOid) {
        git.refs.delete(command.ref);
        git.version += 1;
        lines.push(`ok ${command.ref}\n`);
      } else {
        lines.push(`ng ${command.ref} ${current === undefined ? 'no such ref' : 'old value mismatch'}\n`);
      }
      continue;
    }
    if (!git.hasObject(command.newOid)) {
      lines.push(`ng ${command.ref} missing objects\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        lines.push(`ng ${command.ref} bad create\n`);
        continue;
      }
      git.refs.set(command.ref, command.newOid);
      git.version += 1;
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current !== command.oldOid) {
      lines.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (!isDescendant(git, command.newOid, command.oldOid)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    git.refs.set(command.ref, command.newOid);
    git.version += 1;
    lines.push(`ok ${command.ref}\n`);
  }
  return { unpackOk, lines };
}

/** Parse a received packfile into the store; idempotent, verifies the trailer. */
function unpackInto(git: GitState, pack: Buffer): void {
  if (pack.length < 32) throw new Error('pack shorter than header+trailer');
  if (pack.readUInt32BE(0) !== 0x5041434b) throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(pack.subarray(pack.length - 20))) throw new Error('pack trailer mismatch');
  const existing = {
    get: (oid: string) => {
      const found = git.getObject(oid);
      return found === null ? null : { type: found.type, content: found.body };
    },
  };
  const parsed = parsePack(pack, existing as never);
  if (parsed.length !== count) throw new Error(`pack declares ${count} objects, parsed ${parsed.length}`);
  for (const object of parsed) {
    const oid = createSha1(object.type, object.content);
    if (process.env.FORGE_DEBUG === '1') console.error(`[unpack] ${typeNameOf(object.type)} ${oid} (${object.content.length}B)`);
    git.addObjectWithSha(oid, object.type, object.content);
  }
}
