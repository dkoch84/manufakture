// A simulated client: the last confirmed document, a queue of its own entries, rebase by replay
// with the id remap of ADR 0009 decisions 4 and 5.
//
// The spike's one structural choice beyond the ADR: every queued command is kept in the
// client's *current* naming ("world" names), and whenever the confirmed document moves, one
// rename table is computed for all of the client's own fresh ids that may still be renamed, and
// applied to every queued command at once (a sent copy of an in-flight command is kept apart and
// never edited). Applying one simultaneous table to the whole queue is what keeps the names
// unambiguous; per-entry tables applied one after another collide (see the write-up).

import {
  applyCommand,
  restoredDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { Broadcast, SyncEntry, Verdict } from './protocol.ts';
import { remap, TOMBSTONE, type RemapStats, type RenameTable, type Resolver } from './remap.ts';
import {
  counterKey,
  counters,
  freshRanges,
  idText,
  type Counters,
  type FreshRange,
} from './scopes.ts';

export interface ClientOptions {
  /** Remap ids on rebase (off: an id collision drops the command, the ablation). */
  remap: boolean;
  /** Re-derive a replaceDocument's counters from the rebased document before replaying it. */
  rederiveReplace: boolean;
}

interface QEntry {
  local: number;
  label: string;
  /** The command in the client's current naming. */
  cmd: Command;
  fresh: FreshRange[];
  state: 'unsent' | 'inflight';
  /** In flight: what the server has, never edited. */
  sent?: Command | undefined;
  /** In flight: the ids `sent` allocates, as sent. */
  created?: FreshRange[] | undefined;
  clientSeq?: number | undefined;
  prevSeq?: number | undefined;
  baseRev: number;
  /** A refusal not yet acted on (waiting for the pull up to `headRev`). */
  verdict?: { code: string; headRev: number } | undefined;
  /** Refused as predecessor-refused; returns once its predecessor is resolved. */
  predRefused?: boolean | undefined;
  /** Known locally to be refused as id-reused: its ids collide with confirmed ones. */
  certain?: boolean | undefined;
  /** The server said it was accepted; the broadcast will confirm it. */
  accepted?: boolean | undefined;
  lastSent: number;
  remaps: number;
  /** For a restore (replaceDocument): the past document it restores, its intent. */
  restoreOf?: ManufaktureDocument | undefined;
}

export interface ClientStats {
  generated: number;
  accepted: number;
  dropped: number;
  droppedBy: Record<string, number>;
  /** Drops by error code and command type. */
  droppedByType: Record<string, number>;
  /** Entries whose ids were renamed at least once. */
  remappedEntries: number;
  /** Rename tables that were not empty. */
  remapRounds: number;
  /** A command that still failed `id-reused` locally after a remap: a remap bug. */
  remapMisses: number;
  missLog: string[];
  /** A locally-certain id-reused entry that the server accepted anyway (should never happen). */
  certainAccepted: number;
  /** An in-flight entry found after an unsent one that is not doomed (queue order broken). */
  orderViolations: number;
  resubmits: number;
  rebases: number;
  remap: RemapStats;
  /** Time spent in the remap and in replaying commands during rebases, in ms. */
  remapMs: number;
  replayMs: number;
  /** Per generator category: generated, accepted, dropped. */
  byCategory: Record<string, { generated: number; accepted: number; dropped: number }>;
}

export interface Transport {
  send(entry: SyncEntry): void;
  now(): number;
  /** Runs `fn` after about one round trip. */
  later(fn: () => void): void;
}

export class Client {
  readonly id: string;
  confirmed: ManufaktureDocument;
  confirmedRev = 0;
  visible: ManufaktureDocument;
  readonly queue: QEntry[] = [];
  readonly stats: ClientStats = {
    generated: 0,
    accepted: 0,
    dropped: 0,
    droppedBy: {},
    droppedByType: {},
    remappedEntries: 0,
    remapRounds: 0,
    remapMisses: 0,
    missLog: [],
    certainAccepted: 0,
    orderViolations: 0,
    resubmits: 0,
    rebases: 0,
    remap: { renamed: 0, unresolved: 0, orderFlips: 0, byScope: {} },
    byCategory: {},
    remapMs: 0,
    replayMs: 0,
  };
  online = true;
  /** Called with each new confirmed document (the generator keeps some for restores). */
  onConfirmed?: (doc: ManufaktureDocument) => void;
  private readonly buffer = new Map<number, Broadcast>();
  private readonly refusedSeqs = new Set<number>();
  private tombstones: RenameTable = new Map();
  private nextSeq = 0;
  private latestAccepted: number | undefined;
  private nextLocal = 0;
  private readonly options: ClientOptions;
  private readonly transport: Transport;

  constructor(id: string, doc: ManufaktureDocument, options: ClientOptions, transport: Transport) {
    this.id = id;
    this.confirmed = doc;
    this.visible = doc;
    this.options = options;
    this.transport = transport;
  }

  /** The user made a command on the visible document. */
  execute(command: Command, label: string, restoreOf?: ManufaktureDocument): void {
    const r = applyCommand(this.visible, command);
    if (!r.ok) throw new Error(`generator made a command that does not apply: ${r.error.message}`);
    this.stats.generated++;
    this.category(label).generated++;
    this.queue.push({
      local: ++this.nextLocal,
      label,
      cmd: command,
      fresh: freshRanges(counters(this.visible), counters(r.value.document)),
      state: 'unsent',
      baseRev: this.confirmedRev,
      lastSent: 0,
      remaps: 0,
      restoreOf,
    });
    this.rebase();
  }

  /** Bench only: queue commands made offline, without a rebase after each. */
  load(commands: Command[]): void {
    for (const command of commands) {
      const r = applyCommand(this.visible, command);
      if (!r.ok) throw new Error(`load: ${r.error.message}`);
      this.queue.push({
        local: ++this.nextLocal,
        label: 'bench',
        cmd: command,
        fresh: freshRanges(counters(this.visible), counters(r.value.document)),
        state: 'unsent',
        baseRev: this.confirmedRev,
        lastSent: 0,
        remaps: 0,
      });
      this.visible = r.value.document;
    }
  }

  receive(b: Broadcast): void {
    this.buffer.set(b.rev, b);
    let moved = false;
    for (
      let next = this.buffer.get(this.confirmedRev + 1);
      next;
      next = this.buffer.get(this.confirmedRev + 1)
    ) {
      this.buffer.delete(next.rev);
      this.confirmedRev = next.rev;
      let command = next.entry.command;
      if (next.entry.clientId === this.id) {
        const i = this.queue.findIndex(
          (e) => e.state === 'inflight' && e.clientSeq === next.entry.clientSeq,
        );
        if (i >= 0) {
          const e = this.queue[i]!;
          if (e.certain) this.stats.certainAccepted++;
          command = e.sent!;
          this.category(e.label).accepted++;
          this.queue.splice(i, 1);
        }
        this.latestAccepted = Math.max(this.latestAccepted ?? 0, next.entry.clientSeq);
        this.stats.accepted++;
      }
      const r = applyCommand(this.confirmed, command);
      if (!r.ok)
        throw new Error(`${this.id}: a confirmed entry does not apply: ${r.error.message}`);
      this.confirmed = r.value.document;
      this.onConfirmed?.(this.confirmed);
      moved = true;
    }
    if (moved) this.rebase();
  }

  verdict(v: Verdict): void {
    const e = this.queue.find((x) => x.state === 'inflight' && x.clientSeq === v.clientSeq);
    if (!e) return;
    if (v.kind === 'accepted') {
      e.accepted = true;
      return;
    }
    if (v.kind === 'predecessor-unknown') {
      // The predecessor is still on its way (or was lost: the timer resends it). Try this one
      // again a little later rather than resend everything, which only adds reordering.
      this.transport.later(() => {
        if (e.state === 'inflight' && !e.verdict && !e.accepted && this.queue.includes(e)) {
          this.stats.resubmits++;
          e.lastSent = this.transport.now();
          this.transport.send(this.entryOf(e));
        }
      });
      return;
    }
    if (e.verdict) return;
    e.verdict = { code: v.code, headRev: v.headRev };
    this.refusedSeqs.add(v.clientSeq);
    if (v.code === 'predecessor-refused' && e.prevSeq !== undefined)
      this.refusedSeqs.add(e.prevSeq);
    this.rebase();
  }

  /** Resubmit, in clientSeq order, every in-flight entry with no verdict yet. */
  resubmitAll(olderThan = Infinity): void {
    if (!this.online) return;
    const now = this.transport.now();
    for (const e of this.queue) {
      if (e.state !== 'inflight' || e.verdict || e.accepted) continue;
      if (now - e.lastSent < olderThan) continue;
      e.lastSent = now;
      this.stats.resubmits++;
      this.transport.send(this.entryOf(e));
    }
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (online) this.rebase();
  }

  private category(label: string) {
    return (this.stats.byCategory[label] ??= { generated: 0, accepted: 0, dropped: 0 });
  }

  private entryOf(e: QEntry): SyncEntry {
    return {
      clientId: this.id,
      clientSeq: e.clientSeq!,
      prevSeq: e.prevSeq,
      baseRev: e.baseRev,
      label: e.label,
      command: e.sent!,
      created: e.created,
    };
  }

  /**
   * Removes a dropped entry. Its fresh ids become tombstones in the given table (default: the one
   * the next pass starts from), so a held entry that names them can never be bound to whatever
   * later takes those numbers: it fails and is dropped in turn, as an edit of a feature the
   * dropped entry created must.
   */
  /** The first few drop messages, for the write-up's examples. */
  readonly dropSamples: string[] = [];

  private drop(e: QEntry, code: string, table: RenameTable = this.tombstones, message = ''): void {
    if (this.dropSamples.length < 30) this.dropSamples.push(`${code} ${e.cmd.type}: ${message}`);
    for (const f of e.fresh) {
      let m = table.get(f.scope);
      if (!m) table.set(f.scope, (m = new Map()));
      for (let n = f.start; n < f.end; n++) {
        const id = idText(f.counter, n);
        const tomb = TOMBSTONE;
        let found = false;
        for (const [k, v] of m) {
          if (v === id) {
            m.set(k, tomb);
            found = true;
          }
        }
        if (!found) m.set(id, tomb);
      }
    }
    const i = this.queue.indexOf(e);
    if (i >= 0) this.queue.splice(i, 1);
    this.category(e.label).dropped++;
    this.stats.dropped++;
    this.stats.droppedBy[code] = (this.stats.droppedBy[code] ?? 0) + 1;
    const k = `${code} ${e.cmd.type}`;
    this.stats.droppedByType[k] = (this.stats.droppedByType[k] ?? 0) + 1;
  }

  /** Act on refusals whose head revision has been pulled. */
  private processVerdicts(): void {
    for (const e of [...this.queue]) {
      if (e.state !== 'inflight') continue;
      if (e.verdict && e.verdict.headRev <= this.confirmedRev) {
        const code = e.verdict.code;
        e.verdict = undefined;
        if (code === 'id-reused' && this.options.remap) {
          this.toUnsent(e);
        } else if (code === 'predecessor-refused') {
          e.predRefused = true;
        } else {
          this.drop(e, code);
          continue;
        }
      }
      if (e.predRefused) {
        const pred = this.queue.find((x) => x.state === 'inflight' && x.clientSeq === e.prevSeq);
        if (!pred) this.toUnsent(e); // the predecessor was remapped or dropped
      }
    }
  }

  private toUnsent(e: QEntry): void {
    e.state = 'unsent';
    // A verdict belongs to one clientSeq: a stale one (a resubmission's answer that arrived after
    // the entry was resolved) must not be read as the verdict of the entry's next clientSeq.
    e.verdict = undefined;
    e.sent = undefined;
    e.created = undefined;
    e.clientSeq = undefined;
    e.prevSeq = undefined;
    e.predRefused = undefined;
    e.certain = undefined;
    e.accepted = undefined;
  }

  rebase(): void {
    this.stats.rebases++;
    this.processVerdicts();

    // B: replay the in-flight entries that may still be accepted, unchanged.
    let doc = this.confirmed;
    const doomed = new Set<number>();
    const frozen = new Set<QEntry>();
    const hidden = new Set<QEntry>();
    let blocked = false;
    let seenUnsent = false;
    for (const e of this.queue) {
      if (e.state === 'unsent') {
        seenUnsent = true;
        continue;
      }
      const knownRefused =
        e.verdict !== undefined ||
        e.predRefused === true ||
        e.certain === true ||
        this.refusedSeqs.has(e.clientSeq!);
      const chained =
        e.prevSeq !== undefined && (this.refusedSeqs.has(e.prevSeq) || doomed.has(e.prevSeq));
      if (knownRefused || chained) {
        doomed.add(e.clientSeq!);
        hidden.add(e);
        blocked = true;
        continue;
      }
      if (seenUnsent) this.stats.orderViolations++;
      frozen.add(e);
      if (blocked) {
        hidden.add(e);
        continue;
      }
      // An in-flight entry whose fresh ids are below the confirmed counters can never be accepted
      // (counters only grow), whatever error the server will name. Rename it in our naming now,
      // before the user can make a command that names the confirmed item with the same id.
      const now = counters(doc);
      const collides = e.fresh.some((f) => {
        const n = now.get(counterKey(f.scope, f.counter));
        return n !== undefined && f.start < n;
      });
      const r = collides ? undefined : applyCommand(doc, e.sent!);
      if (r?.ok) {
        doc = r.value.document;
      } else if (r === undefined || r.error.code === 'id-reused') {
        // Counters never go back, so the server will refuse it too: rename it in our naming now.
        e.certain = true;
        frozen.delete(e);
        doomed.add(e.clientSeq!);
        hidden.add(e);
        blocked = true;
      } else {
        hidden.add(e);
        blocked = true;
      }
    }

    // C+E: one pass in queue order. Each entry that may still be renamed gets the next free
    // numbers for its own fresh ids (from the counters of the document replayed so far, then of
    // the reservations of hidden entries), and is rewritten through one simultaneous table: the
    // renames of every earlier entry (keys: their ids in our current naming) plus its own.
    // Then it is replayed for display, unless it or an entry before it is held.
    const resolver = this.resolver();
    const table: RenameTable = this.tombstones;
    this.tombstones = new Map();
    const next: Counters = counters(doc);
    const local = this.localScopes();
    let renamedAny = false;
    blocked = false;
    for (const e of [...this.queue]) {
      if (frozen.has(e)) {
        if (hidden.has(e)) {
          blocked = true;
          advance(next, e.fresh);
        }
        continue;
      }
      if (this.options.remap) {
        for (const f of e.fresh) {
          if (local.has(f.scope)) continue;
          const k = counterKey(f.scope, f.counter);
          const start = next.get(k) ?? 1;
          next.set(k, start + (f.end - f.start));
          if (start === f.start) continue;
          let m = table.get(f.scope);
          if (!m) table.set(f.scope, (m = new Map()));
          for (let n = f.start; n < f.end; n++) {
            m.set(idText(f.counter, n), idText(f.counter, start + n - f.start));
          }
        }
        for (const [src, dst] of duplicates(e.cmd)) {
          // The copy's ids are the source's: they follow the source part's renames so far, and
          // its counters start from the source's.
          const m = table.get(`part:${src}`);
          if (m) {
            let d = table.get(`part:${dst}`);
            if (!d) table.set(`part:${dst}`, (d = new Map()));
            for (const [from, to] of m) if (!d.has(from)) d.set(from, to);
          }
          for (const [k, n] of [...next]) {
            const [scope, c] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
            if (scope !== `part:${src}`) continue;
            const dk = counterKey(`part:${dst}`, c);
            next.set(dk, Math.max(next.get(dk) ?? 1, n));
          }
        }
        if (table.size > 0) {
          const t = performance.now();
          const before = e.cmd;
          e.cmd = remap(e.cmd, table, resolver, this.stats.remap);
          if (e.cmd.type === 'replaceDocument') e.cmd = coverCounters(e.cmd, table);
          e.fresh = renameFresh(e.fresh, table);
          if (JSON.stringify(before) !== JSON.stringify(e.cmd)) {
            renamedAny = true;
            if (e.remaps++ === 0) this.stats.remappedEntries++;
          }
          this.stats.remapMs += performance.now() - t;
        }
      } else {
        advance(next, e.fresh);
      }
      if (hidden.has(e) || blocked) {
        hidden.add(e);
        blocked = true;
        continue;
      }
      if (e.cmd.type === 'replaceDocument' && this.options.rederiveReplace && e.restoreOf) {
        // A restore is rebased as its intent: the past document, on the current head.
        e.cmd = { type: 'replaceDocument', document: restoredDocument(doc, e.restoreOf) };
      }
      const t = performance.now();
      const r = applyCommand(doc, e.cmd);
      this.stats.replayMs += performance.now() - t;
      if (!r.ok) {
        let code: string = r.error.code;
        if (code === 'id-reused') {
          // Our own fresh id still taken: a remap bug. Any other id: the command re-introduces an
          // id that a concurrent whole-feature edit removed (a stale edit), which no remap fixes.
          const id = /Id "([^"]+)"/.exec(r.error.message)?.[1] ?? '';
          if (ownsId(e.fresh, id)) {
            if (this.options.remap) {
              this.stats.remapMisses++;
              this.stats.missLog.push(`${e.label}: ${r.error.message}`);
            }
          } else code = 'id-reused-stale-edit';
        }
        this.drop(e, code, table, r.error.message);
        continue;
      }
      doc = r.value.document;
      for (const [k, n] of counters(doc)) if ((next.get(k) ?? 1) < n) next.set(k, n);
    }
    if (renamedAny) this.stats.remapRounds++;

    // The visible document, with counters past every hidden entry's ids, so a new command never
    // takes an id a held entry already holds.
    this.visible = reserve(
      doc,
      this.queue.filter((e) => hidden.has(e)),
    );

    // F: send unsent entries in queue order, up to the first held one.
    if (!this.online) return;
    let prev = this.latestAccepted;
    for (const e of this.queue) {
      if (hidden.has(e)) break;
      if (e.state === 'inflight') {
        prev = e.clientSeq;
        continue;
      }
      e.state = 'inflight';
      e.clientSeq = ++this.nextSeq;
      e.prevSeq = prev;
      e.sent = e.cmd;
      e.created = e.fresh.map((f) => ({ ...f }));
      e.baseRev = this.confirmedRev;
      e.lastSent = this.transport.now();
      prev = e.clientSeq;
      this.transport.send(this.entryOf(e));
    }
  }

  /**
   * Scopes the queue itself created empty (addPart, addAssembly): no other client can have
   * allocated in them, so their ids keep their numbers. A duplicated part is not one of them:
   * its ids are copies of the source part's and follow the source's renames.
   */
  private localScopes(): Set<string> {
    const local = new Set<string>();
    const scan = (c: Command) => {
      if (c.type === 'batch') c.commands.forEach(scan);
      else if (c.type === 'addPart') local.add(`part:${c.partId}`);
      else if (c.type === 'addAssembly') local.add(`asm:${c.assemblyId}`);
    };
    for (const e of this.queue) scan(e.cmd);
    return local;
  }

  /** Which part an instance shows and a CAM setup machines, in the client's current naming. */
  private resolver(): Resolver {
    const inst = new Map<string, string>();
    const setups = new Map<string, string>();
    for (const a of this.visible.assemblies) {
      for (const i of a.instances)
        if ('part' in i.source) inst.set(`${a.id}/${i.id}`, i.source.part);
    }
    for (const s of this.visible.cam.setups) setups.set(s.id, s.part);
    const scan = (c: Command) => {
      if (c.type === 'batch') c.commands.forEach(scan);
      else if (c.type === 'addInstance' && 'part' in c.instance.source) {
        inst.set(`${c.assemblyId}/${c.instance.id}`, c.instance.source.part);
      } else if (c.type === 'addCamSetup') setups.set(c.setup.id, c.setup.part);
    };
    for (const e of this.queue) scan(e.cmd);
    return {
      instancePart: (a, i) => inst.get(`${a}/${i}`),
      setupPart: (s) => setups.get(s),
    };
  }

  /** Queue length, for the end-of-run check. */
  pending(): number {
    return this.queue.length;
  }
}

/** The (source, copy) part ids of the duplicatePart commands in a command. */
function duplicates(c: Command): Array<[string, string]> {
  if (c.type === 'batch') return c.commands.flatMap(duplicates);
  return c.type === 'duplicatePart' ? [[c.sourcePartId, c.partId]] : [];
}

/** Whether `id` (a sub-id's base or `kind#n`) is in one of the fresh ranges. */
function ownsId(fresh: FreshRange[], id: string): boolean {
  const hash = id.lastIndexOf('#');
  const sub = /^([a-z])([0-9]+)/.exec(id);
  const [counter, n] =
    hash > 0 && /#[0-9]+$/.test(id) && !sub
      ? [id.slice(0, hash), idNumber(id)]
      : sub
        ? [sub[1]!, Number(sub[2])]
        : ['', 0];
  return fresh.some((f) => f.counter === counter && n >= f.start && n < f.end);
}

function advance(next: Counters, fresh: FreshRange[]): void {
  for (const f of fresh) {
    const k = counterKey(f.scope, f.counter);
    next.set(k, Math.max(next.get(k) ?? 1, f.end));
  }
}

function renameFresh(fresh: FreshRange[], table: RenameTable): FreshRange[] {
  return fresh.map((f) => {
    let scope = f.scope;
    const colon = scope.indexOf(':');
    if (colon > 0) {
      const to = table.get('doc')?.get(scope.slice(colon + 1));
      if (to) scope = `${scope.slice(0, colon)}:${to}`;
    }
    const first = table.get(f.scope)?.get(idText(f.counter, f.start));
    if (!first || first === TOMBSTONE) return { ...f, scope };
    const start = idNumber(first);
    return { scope, counter: f.counter, start, end: start + (f.end - f.start) };
  });
}

/** The number of an id: `extrude#7` and `e7` give 7. */
function idNumber(id: string): number {
  const hash = id.lastIndexOf('#');
  return Number(hash >= 0 ? id.slice(hash + 1) : id.slice(1));
}

/** After renaming ids inside a replacement document, move its counters past them. */
function coverCounters(cmd: Command, table: RenameTable): Command {
  if (cmd.type !== 'replaceDocument') return cmd;
  const d = cmd.document;
  const bump = (scope: string, nextIds: Record<string, number>): Record<string, number> => {
    const m = table.get(scope);
    if (!m) return nextIds;
    const out = { ...nextIds };
    for (const to of m.values()) {
      if (to === TOMBSTONE) continue;
      const hash = to.lastIndexOf('#');
      const c = hash >= 0 ? to.slice(0, hash) : to.slice(0, 1);
      out[c] = Math.max(out[c] ?? 1, idNumber(to) + 1);
    }
    return out;
  };
  return {
    type: 'replaceDocument',
    document: {
      ...d,
      nextIds: bump('doc', d.nextIds),
      parts: d.parts.map((p) => ({ ...p, nextIds: bump(`part:${p.id}`, p.nextIds) })),
      assemblies: d.assemblies.map((a) => ({ ...a, nextIds: bump(`asm:${a.id}`, a.nextIds) })),
      cam: { ...d.cam, nextIds: bump('cam', d.cam.nextIds) },
    },
  };
}

/** Moves the document's counters past the ids the given entries hold. */
function reserve(doc: ManufaktureDocument, entries: QEntry[]): ManufaktureDocument {
  if (entries.length === 0) return doc;
  const need = new Map<string, number>();
  for (const e of entries) {
    for (const f of e.fresh) {
      const k = counterKey(f.scope, f.counter);
      need.set(k, Math.max(need.get(k) ?? 1, f.end));
    }
  }
  const bump = (scope: string, nextIds: Record<string, number>): Record<string, number> => {
    let out = nextIds;
    for (const [k, n] of need) {
      const i = k.lastIndexOf('|');
      if (k.slice(0, i) !== scope) continue;
      const c = k.slice(i + 1);
      if ((out[c] ?? 1) < n) out = { ...out, [c]: n };
    }
    return out;
  };
  return {
    ...doc,
    nextIds: bump('doc', doc.nextIds),
    parts: doc.parts.map((p) => ({ ...p, nextIds: bump(`part:${p.id}`, p.nextIds) })),
    assemblies: doc.assemblies.map((a) => ({ ...a, nextIds: bump(`asm:${a.id}`, a.nextIds) })),
    cam: { ...doc.cam, nextIds: bump('cam', doc.cam.nextIds) },
    print: { ...doc.print, nextIds: bump('print', doc.print.nextIds) },
  };
}
