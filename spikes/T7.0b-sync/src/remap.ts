// A first structural id remap over commands and documents (ADR 0009 decision 5).
//
// The walker carries a context (which part, assembly, drawing; which scope `r` ids belong to)
// and classifies each id it meets by its shape and that context:
//   part#, assembly#, cp#, cfg#, font#, drawing#           the document scope
//   inst#, mate#, mc#, explode#, step#                     the current assembly
//   tool#, setup#, facing#, profile#, pocket#, drill#, ... cam
//   print#, item#                                          print
//   sheet#, view#, dim#, note#                             the current drawing
//   any other kind#n                                       a feature of the current part
//   e<n>, k<n> (split and positional suffixes kept)        the current part
//   r<n>                                                   the current `r` scope
//   anything with `:` or `(`                               a face name or body id (names.ts)
// Free-text fields (names, labels, expression sources) and derived sources (another document)
// are never read. Record keys are ids in two places: configuration row values (cp#) and
// setPoses (inst#).
//
// Context that a command does not carry is looked up through a `Resolver`: the part an instance
// shows (mate connectors name faces of it) and the part a CAM setup machines (operations name its
// sketches, holes and faces). That is the one place the remap needs a document, not only the
// command.

import { rewriteName } from './names.ts';
import type { ScopeKey } from './scopes.ts';

/** scope -> old id -> new id. Sub-ids are keyed by their base (`e7`). */
export type RenameTable = Map<ScopeKey, Map<string, string>>;

/**
 * The table value for an id of a dropped command. A command that names it must fail, never bind
 * to whatever takes the number later. Where an id is a plain field it becomes `kind#0` / `e0`,
 * which the schema refuses (so it cannot be allocated either); inside a face name, where core
 * accepts any text, a valid but unreachable number, so the dependency check refuses it.
 */
export const TOMBSTONE = '\u0000dropped';

function tombstone(id: string, inName: boolean): string {
  const hash = id.lastIndexOf('#');
  const counter = hash > 0 ? id.slice(0, hash) : id[0]!;
  const n = inName ? '999999999999999' : '0';
  return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
}

export interface Resolver {
  instancePart(assemblyId: string, instanceId: string): string | undefined;
  setupPart(setupId: string): string | undefined;
}

export interface RemapStats {
  /** Ids rewritten. */
  renamed: number;
  /** Part-scope ids met where the part could not be resolved (left as they were). */
  unresolved: number;
  /** Edge references whose face list changed its code-unit sort order under the rename. */
  orderFlips: number;
  /** Ids rewritten per scope kind and counter (`part/extrude`, `asm/mc`, `cam/r`, ...). */
  byScope: Record<string, number>;
}

export function emptyStats(): RemapStats {
  return { renamed: 0, unresolved: 0, orderFlips: 0, byScope: {} };
}

interface Ctx {
  part?: string | undefined;
  asm?: string | undefined;
  drawing?: string | undefined;
  rScope?: ScopeKey | undefined;
}

const DOC_KINDS = new Set(['part', 'assembly', 'cp', 'cfg', 'font', 'drawing']);
const ASM_KINDS = new Set(['inst', 'mate', 'mc', 'explode', 'step']);
const CAM_KINDS = new Set([
  'tool',
  'setup',
  'facing',
  'profile',
  'pocket',
  'drill',
  'vcarve',
  'surface3d',
]);
const PRINT_KINDS = new Set(['print', 'item']);
const DRAWING_KINDS = new Set(['sheet', 'view', 'dim', 'note']);
const FREE_TEXT = new Set([
  'name',
  'label',
  'text',
  'documentName',
  'versionName',
  'data',
  'sha256',
  'machine',
  'post',
  'variable',
  'expression',
]);

const FEATURE_ID = /^([a-z][a-zA-Z0-9]*)#([1-9][0-9]*)$/;
const SUB_ID = /^([ekr][1-9][0-9]*)((?:#[a-z]+)*(?:#[0-9]+)*)$/;

export class Remapper {
  readonly stats: RemapStats = emptyStats();
  private readonly table: RenameTable;
  private readonly resolver: Resolver;

  constructor(table: RenameTable, resolver: Resolver) {
    this.table = table;
    this.resolver = resolver;
  }

  private lookup(scope: ScopeKey | undefined, id: string, inName = false): string {
    if (scope === undefined) return id;
    let to = this.table.get(scope)?.get(id);
    if (to === undefined) return id;
    if (to === TOMBSTONE) to = tombstone(id, inName);
    this.stats.renamed++;
    const hash = id.lastIndexOf('#');
    const key = `${scope.replace(/:.*$/, '')}/${hash > 0 ? id.slice(0, hash) : id[0]}`;
    this.stats.byScope[key] = (this.stats.byScope[key] ?? 0) + 1;
    return to;
  }

  private partScope(ctx: Ctx): ScopeKey | undefined {
    return ctx.part === undefined ? undefined : `part:${ctx.part}`;
  }

  /** A plain id (no `:`), classified by shape and context. */
  id(s: string, ctx: Ctx): string {
    const f = FEATURE_ID.exec(s);
    if (f) {
      const kind = f[1]!;
      if (DOC_KINDS.has(kind)) return this.lookup('doc', s);
      if (ASM_KINDS.has(kind)) return this.lookup(ctx.asm && `asm:${ctx.asm}`, s);
      if (CAM_KINDS.has(kind)) return this.lookup('cam', s);
      if (PRINT_KINDS.has(kind)) return this.lookup('print', s);
      if (DRAWING_KINDS.has(kind)) return this.lookup(ctx.drawing && `drawing:${ctx.drawing}`, s);
      if (ctx.part === undefined) {
        this.stats.unresolved++;
        return s;
      }
      return this.lookup(this.partScope(ctx), s);
    }
    const sub = SUB_ID.exec(s);
    if (sub) {
      const base = sub[1]!;
      const scope = base[0] === 'r' ? ctx.rScope : this.partScope(ctx);
      if (scope === undefined) {
        this.stats.unresolved++;
        return s;
      }
      return this.lookup(scope, base) + sub[2];
    }
    return s;
  }

  name(s: string, ctx: Ctx): string {
    if (ctx.part === undefined) {
      this.stats.unresolved++;
      return s;
    }
    const scope = this.partScope(ctx)!;
    return rewriteName(s, {
      feature: (id) => this.lookup(scope, id, true),
      sub: (id) => this.lookup(scope, id, true),
    });
  }

  string(s: string, ctx: Ctx): string {
    return s.includes(':') || s.startsWith('(') ? this.name(s, ctx) : this.id(s, ctx);
  }

  value(v: unknown, ctx: Ctx, key?: string): unknown {
    if (typeof v === 'string')
      return key !== undefined && FREE_TEXT.has(key) ? v : this.string(v, ctx);
    if (Array.isArray(v)) {
      const out = v.map((x) => this.value(x, ctx, key));
      if (key === 'faces' && v.every((x) => typeof x === 'string'))
        this.countFlip(v, out as string[]);
      return out;
    }
    if (v !== null && typeof v === 'object') return this.object(v as Record<string, unknown>, ctx);
    return v;
  }

  private countFlip(before: string[], after: string[]): void {
    const order = (xs: string[]) =>
      xs
        .map((x, i) => [x, i] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((p) => p[1])
        .join(',');
    if (order(before) !== order(after)) this.stats.orderFlips++;
  }

  object(o: Record<string, unknown>, outer: Ctx): Record<string, unknown> {
    // A derived source or a pinned instance source names another document: opaque.
    if ('documentId' in o) return o;
    const ctx: Ctx = { ...outer };
    // Context from the object's own fields, read before anything is renamed.
    if (typeof o.partId === 'string') ctx.part = o.partId;
    if (typeof o.assemblyId === 'string') {
      ctx.asm = o.assemblyId;
      ctx.rScope = `asm:${o.assemblyId}`;
    }
    if (typeof o.drawingId === 'string') ctx.drawing = o.drawingId;
    if (typeof o.type === 'string') {
      if (o.type.includes('Cam')) ctx.rScope = 'cam';
      else if (o.type.includes('Print')) ctx.rScope = 'print';
      else if (typeof o.partId === 'string') ctx.rScope = `part:${o.partId}`;
    }
    if (typeof o.setupId === 'string' && o.setupId.startsWith('setup#')) {
      ctx.part = this.resolver.setupPart(o.setupId);
      ctx.rScope = 'cam';
    }
    // A CAM setup: its part.
    if ('operations' in o && 'wcs' in o && typeof o.part === 'string') {
      ctx.part = o.part;
      ctx.rScope = 'cam';
    }
    // A mate connector: names are faces of the instance's part.
    if (typeof o.instance === 'string' && 'inference' in o && ctx.asm !== undefined) {
      ctx.part = this.resolver.instancePart(ctx.asm, o.instance);
    }
    // An instance (or editInstance): its `bodies` are body ids of its source part.
    const src = o.source as Record<string, unknown> | undefined;
    const isInstance = 'pose' in o || o.type === 'editInstance';
    if (isInstance && src !== undefined && typeof src === 'object' && src !== null) {
      ctx.part = typeof src.part === 'string' ? src.part : undefined; // pinned: opaque
    } else if (o.type === 'editInstance' && typeof o.instanceId === 'string' && ctx.asm) {
      ctx.part = this.resolver.instancePart(ctx.asm, o.instanceId);
    }
    // restorePart carries a whole part.
    if (Array.isArray(o.features) && typeof o.id === 'string' && o.id.startsWith('part#')) {
      ctx.part = o.id;
      ctx.rScope = `part:${o.id}`;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'nextIds') {
        out[k] = v;
      } else if (k === 'parts' && Array.isArray(v)) {
        out[k] = v.map((p: Record<string, unknown>) =>
          this.object(p, { ...ctx, part: p.id as string, rScope: `part:${p.id as string}` }),
        );
      } else if (k === 'assemblies' && Array.isArray(v)) {
        out[k] = v.map((a: Record<string, unknown>) =>
          this.object(a, { ...ctx, asm: a.id as string, rScope: `asm:${a.id as string}` }),
        );
      } else if (k === 'drawings' && Array.isArray(v)) {
        out[k] = v.map((d: Record<string, unknown>) =>
          this.object(d, { ...ctx, drawing: d.id as string }),
        );
      } else if (k === 'cam') {
        out[k] = this.value(v, { ...ctx, rScope: 'cam' }, k);
      } else if (k === 'print') {
        out[k] = this.value(v, { ...ctx, rScope: 'print' }, k);
      } else if (k === 'variables') {
        out[k] = v;
      } else if (k === 'source' && typeof v === 'string') {
        out[k] = v; // an expression's source text
      } else if (k === 'bodies' && o.kind === 'derived') {
        out[k] = v; // body ids in the source document
      } else if ((k === 'values' || k === 'poses') && v !== null && typeof v === 'object') {
        const rec: Record<string, unknown> = {};
        for (const [rk, rv] of Object.entries(v as Record<string, unknown>)) {
          rec[this.id(rk, ctx)] = this.value(rv, ctx, rk);
        }
        out[k] = rec;
      } else {
        out[k] = this.value(v, ctx, k);
      }
    }
    return out;
  }
}

export function remap<T>(value: T, table: RenameTable, resolver: Resolver, stats?: RemapStats): T {
  if (table.size === 0) return value;
  const r = new Remapper(table, resolver);
  const out = r.value(value, {}) as T;
  if (stats) {
    stats.renamed += r.stats.renamed;
    stats.unresolved += r.stats.unresolved;
    stats.orderFlips += r.stats.orderFlips;
    for (const [k, v] of Object.entries(r.stats.byScope))
      stats.byScope[k] = (stats.byScope[k] ?? 0) + v;
  }
  return out;
}
