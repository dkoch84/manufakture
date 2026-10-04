import type { Command, SimpleCommand } from './commands';
import { TOMBSTONE_NAME, parseSubId } from './ids';
import { compareNames, mapName } from './names';
import type {
  Assembly,
  CamData,
  CamOperation,
  CamSetup,
  CamWcs,
  ConfigParameter,
  ConfigRow,
  Configurations,
  Dimension,
  DimensionRef,
  DocumentFont,
  Drawing,
  DrawingView,
  ExplodeStep,
  ExplodedView,
  Feature,
  Instance,
  InstanceSource,
  ManufaktureDocument,
  Mate,
  MateConnector,
  Note,
  Part,
  PrintData,
  PrintItem,
  PrintSetup,
  Reference,
  Sheet,
  SketchConstraint,
  SketchEntity,
  ViewSource,
} from './schema';
import {
  CAM_SCOPE,
  DOCUMENT_SCOPE,
  PRINT_SCOPE,
  assemblyScope,
  drawingScope,
  idCounter,
  idText,
  partScope,
  type ScopeKey,
} from './scopes';

/**
 * Id remap (ADR 0009 decision 5 and its amendment, items 6 to 8): rewrite every id in a list of
 * commands, or in a document, through one table keyed by counter scope and old id.
 *
 * Fields are walked structurally, by schema: each command type and each part of the document
 * shape names the scope of every id field it has (feature ids and sub-ids of the part a command
 * names, connector and instance ids of the assembly, operation ids of CAM, ...), never guessed
 * from the id's shape, so a CAM `profile#1` and a feature `profile#1` can never be confused.
 * Face names and body ids go through the name parser (`names.ts`): feature ids of born names,
 * merge and corner members and instance prefixes, sub-id tails with their suffixes kept, and of a
 * derived prefix only its own id. Opaque data is never read: derived and pinned sources (another
 * document), extension `params`, domain data, view params, names, labels and expressions.
 *
 * Some names belong to a part the command does not name: a mate connector names faces of its
 * instance's part, an exploded step's direction faces of its instance's part, a CAM operation
 * faces, sketches and holes of its setup's part, an instance's `bodies` bodies of its source
 * part, a drawing dimension faces of its view's part (or of the last instance on its path). These
 * are resolved through the document the commands apply to (`RemapOptions.document`) and the
 * commands before them in the list, by their ids before the remap. A name that cannot be resolved
 * is left as it is and counted in `RemapReport.unresolved`.
 */

/**
 * Renames, by scope and old id (an id straight from a counter: `extrude#4`, `e7`, `part#2`; a
 * sub-id is keyed by its base, so `e7` also renames `e7#a` and `e7#1`). A new id must be of the
 * same counter. `null` marks the id of a dropped command (a tombstone, amendment item 7): it is
 * rewritten to an id that never binds to anything: `TOMBSTONE_FIELD` in a plain field, refused by
 * the schema or not found; `TOMBSTONE_NAME` inside a face name, refused by the dependency check
 * for a feature id and by the face-name schema for a sub-id tail. Plain JSON, so a sync queue can
 * save it.
 */
export type RenameTable = Readonly<Record<ScopeKey, Readonly<Record<string, string | null>>>>;

/** The number a tombstone gets in a plain id field: `kind#0`, `e0`, refused by every id schema. */
export const TOMBSTONE_FIELD = 0;
/** The number a tombstone gets inside a face name (`TOMBSTONE_NAME` of `ids.ts`, re-exported). */
export { TOMBSTONE_NAME };

/** The tombstone for `id` (a plain field, or inside a name). */
export function tombstoneId(id: string, inName: boolean): string {
  const c = idCounter(id);
  const counter = c?.counter ?? id;
  return idText(counter, inName ? TOMBSTONE_NAME : TOMBSTONE_FIELD);
}

/** Answers questions the commands alone cannot: which part a name belongs to. */
export interface RemapResolver {
  /** The part an instance shows (`undefined`: unknown, or a pinned source in another document). */
  instancePart(assemblyId: string, instanceId: string): string | undefined;
  /** The part a CAM setup machines. */
  setupPart(setupId: string): string | undefined;
  /** What a drawing view shows. */
  viewSource(drawingId: string, viewId: string): ViewSource | undefined;
}

export interface RemapReport {
  /** Ids rewritten (each occurrence). */
  renamed: number;
  /** Names or body ids whose part could not be resolved, left as they were. */
  unresolved: number;
  /**
   * Stored face lists (edge and vertex references) whose code-unit order the rename changed
   * (`e9` to `e10`). Positions are kept, so the stored list is no longer sorted, and the kernel
   * reads a chamfer's reference face and an edge's direction from that order: a known
   * limitation (ADR 0009 amendment, item 9), reported rather than fixed.
   */
  orderFlips: number;
}

export function emptyRemapReport(): RemapReport {
  return { renamed: 0, unresolved: 0, orderFlips: 0 };
}

export interface RemapOptions {
  /**
   * The document the commands apply to, in the same (old) naming: resolves instance, setup and
   * view ids that commands earlier in the list do not define. Without it only the list is used.
   */
  readonly document?: ManufaktureDocument;
  /** Filled with counts as the remap goes. */
  readonly report?: RemapReport;
}

/**
 * Called for every id the walker meets: its scope, the id (a sub-id without its suffix), and
 * whether it sits inside a face name or body id. Returns the id to write.
 */
export type IdVisitor = (scope: ScopeKey, id: string, inName: boolean) => string;

/** Resolves through a document plus the commands walked so far (old naming). */
class QueueResolver implements RemapResolver {
  private readonly instances = new Map<string, string | null>();
  private readonly setups = new Map<string, string>();
  private readonly views = new Map<string, ViewSource>();
  private doc: ManufaktureDocument | undefined;

  constructor(doc: ManufaktureDocument | undefined) {
    this.doc = doc;
  }

  instancePart(assemblyId: string, instanceId: string): string | undefined {
    const key = `${assemblyId}\u0000${instanceId}`;
    if (this.instances.has(key)) return this.instances.get(key) ?? undefined;
    const inst = this.doc?.assemblies
      .find((a) => a.id === assemblyId)
      ?.instances.find((i) => i.id === instanceId);
    return inst !== undefined && 'part' in inst.source ? inst.source.part : undefined;
  }

  setupPart(setupId: string): string | undefined {
    return this.setups.get(setupId) ?? this.doc?.cam.setups.find((s) => s.id === setupId)?.part;
  }

  viewSource(drawingId: string, viewId: string): ViewSource | undefined {
    const known = this.views.get(`${drawingId}\u0000${viewId}`);
    if (known !== undefined) return known;
    for (const sheet of this.doc?.drawings?.find((d) => d.id === drawingId)?.sheets ?? []) {
      const v = sheet.views.find((x) => x.id === viewId);
      if (v !== undefined) return v.source;
    }
    return undefined;
  }

  private setInstance(assemblyId: string, inst: { id: string; source: InstanceSource }): void {
    this.instances.set(
      `${assemblyId}\u0000${inst.id}`,
      'part' in inst.source ? inst.source.part : null,
    );
  }

  private setDrawing(drawingId: string, sheets: readonly Sheet[]): void {
    for (const s of sheets) for (const v of s.views) this.setView(drawingId, v);
  }

  private setView(drawingId: string, v: DrawingView): void {
    this.views.set(`${drawingId}\u0000${v.id}`, v.source);
  }

  /** Learns what a command defines, after it has been walked. */
  learn(command: Command): void {
    switch (command.type) {
      case 'batch':
        for (const c of command.commands) this.learn(c);
        return;
      case 'replaceDocument':
        this.doc = command.document;
        this.instances.clear();
        this.setups.clear();
        this.views.clear();
        return;
      case 'addInstance':
      case 'restoreInstance':
        this.setInstance(command.assemblyId, command.instance);
        return;
      case 'editInstance':
        if (command.source !== undefined) {
          this.setInstance(command.assemblyId, { id: command.instanceId, source: command.source });
        }
        return;
      case 'restoreAssembly':
        for (const i of command.assembly.instances) this.setInstance(command.assembly.id, i);
        return;
      case 'addCamSetup':
      case 'restoreCamSetup':
        this.setups.set(command.setup.id, command.setup.part);
        return;
      case 'editCamSetup':
        if (command.part !== undefined) this.setups.set(command.setupId, command.part);
        return;
      case 'addView':
      case 'editView':
      case 'restoreView':
        this.setView(command.drawingId, command.view);
        return;
      case 'addSheet':
      case 'restoreSheet':
        this.setDrawing(command.drawingId, [command.sheet]);
        return;
      case 'addDrawing':
      case 'restoreDrawing':
        this.setDrawing(command.drawing.id, command.drawing.sheets);
        return;
      default:
        return;
    }
  }
}

/**
 * Raises a scope's counters so they still cover every id they covered: a counter at `c` says ids
 * below `c` were handed out, so it is raised past the new id of every renamed id below `c`.
 */
function raiseCounters(
  nextIds: Readonly<Record<string, number>>,
  renames: Readonly<Record<string, string | null>> | undefined,
): Record<string, number> {
  const out = { ...nextIds };
  if (renames === undefined) return out;
  for (const [from, to] of Object.entries(renames)) {
    if (to === null) continue;
    const a = idCounter(from);
    const b = idCounter(to);
    if (a === undefined || b === undefined || a.counter !== b.counter) continue;
    const have = Object.hasOwn(nextIds, a.counter) ? nextIds[a.counter]! : 1;
    if (a.n >= have) continue;
    const now = Object.hasOwn(out, b.counter) ? out[b.counter]! : 1;
    if (b.n + 1 > now) out[b.counter] = b.n + 1;
  }
  return out;
}

const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;

/**
 * The structural walker. `visit` decides what each id becomes; `counters`, when given, raises the
 * `nextIds` of every scope the walker passes through (so a renamed document stays valid).
 */
export class IdWalker {
  constructor(
    private readonly visit: IdVisitor,
    private readonly resolver: RemapResolver,
    private readonly report: RemapReport,
    private readonly counters?: (
      scope: ScopeKey,
      nextIds: Record<string, number>,
    ) => Record<string, number>,
  ) {}

  // Primitives -------------------------------------------------------------------------------

  private nextIds(scope: ScopeKey, nextIds: Record<string, number>): Record<string, number> {
    return this.counters === undefined ? nextIds : this.counters(scope, nextIds);
  }

  /** An id straight from a counter (`part#2`, `inst#3`, `tool#1`, `extrude#4`). */
  id(scope: ScopeKey, id: string): string {
    return this.visit(scope, id, false);
  }

  /** A sub-id (`e7`, `e7#a`, `k2`, `r1`): the base is renamed, the split suffix kept. */
  sub(scope: ScopeKey, id: string): string {
    const p = parseSubId(id);
    if (p === undefined) return id;
    const base = idText(p.counter, p.n);
    return this.visit(scope, base, false) + p.split;
  }

  /** A face name of a part (`undefined`: the part is not known; left as it is). */
  name(part: string | undefined, name: string): string {
    if (part === undefined) {
      this.report.unresolved++;
      return name;
    }
    const scope = partScope(part);
    return mapName(name, {
      feature: (id) => this.visit(scope, id, true),
      sub: (id) => this.visit(scope, id, true),
    });
  }

  /** A body id of a part: a bare feature id (`extrude#3`), or a name (`pattern#2:i3`). */
  body(part: string | undefined, id: string): string {
    if (FEATURE_ID.test(id)) {
      if (part === undefined) {
        this.report.unresolved++;
        return id;
      }
      return this.visit(partScope(part), id, true);
    }
    return this.name(part, id);
  }

  private names(part: string | undefined, list: readonly string[]): string[] {
    const out = list.map((n) => this.name(part, n));
    if (out.length > 1 && part !== undefined) {
      for (let i = 1; i < list.length; i++) {
        if (
          Math.sign(compareNames(list[i - 1]!, list[i]!)) !==
          Math.sign(compareNames(out[i - 1]!, out[i]!))
        ) {
          this.report.orderFlips++;
          break;
        }
      }
    }
    return out;
  }

  private bodies(part: string | undefined, list: readonly string[]): string[] {
    return list.map((b) => this.body(part, b));
  }

  /** A stored face, edge or vertex reference (`ref`), names in `part`. */
  private topo<R extends object>(part: string | undefined, ref: R): R {
    const r = ref as { face?: string; faces?: readonly string[]; ends?: readonly string[] };
    if (r.face !== undefined) return { ...ref, face: this.name(part, r.face) };
    const out: Record<string, unknown> = { ...ref, faces: this.names(part, r.faces ?? []) };
    if (r.ends !== undefined) out.ends = this.names(part, r.ends);
    return out as R;
  }

  /** A `Reference` (`{ id, ref }`): its id in `rScope`, its names in `part`. */
  private reference<R extends { id: string; ref: object }>(
    rScope: ScopeKey,
    part: string | undefined,
    r: R,
  ): R {
    return { ...r, id: this.sub(rScope, r.id), ref: this.topo(part, r.ref) };
  }

  // Parts and features -------------------------------------------------------------------------

  /** A feature of part `part` (old id). */
  feature(part: string, f: Feature): Feature {
    const ps = partScope(part);
    const fid = (id: string) => this.id(ps, id);
    const sub = (id: string) => this.sub(ps, id);
    const ref = <R extends Reference>(r: R): R => this.reference(ps, part, r);
    const id = fid(f.id);
    const scoped = <T extends { scope?: readonly string[] }>(x: T): T =>
      x.scope === undefined ? x : { ...x, scope: this.bodies(part, x.scope) };
    switch (f.kind) {
      case 'sketch':
        return {
          ...f,
          id,
          plane: f.plane.type === 'face' ? { ...f.plane, face: ref(f.plane.face) } : f.plane,
          entities: f.entities.map((e) => this.entity(ps, e)),
          constraints: f.constraints.map((c) => this.constraint(ps, c)),
        };
      case 'extrude':
        return scoped({
          ...f,
          id,
          profile: this.profile(ps, f.profile),
          extent:
            f.extent.type === 'upToFace' ? { ...f.extent, face: ref(f.extent.face) } : f.extent,
        });
      case 'revolve':
        return scoped({
          ...f,
          id,
          profile: this.profile(ps, f.profile),
          axis:
            f.axis.type === 'edge'
              ? { ...f.axis, edge: ref(f.axis.edge) }
              : { ...f.axis, entity: sub(f.axis.entity) },
        });
      case 'fillet':
      case 'chamfer':
        return { ...f, id, edges: f.edges.map(ref) };
      case 'shell':
        return { ...f, id, faces: f.faces.map(ref) };
      case 'hole':
        return scoped({ ...f, id, sketch: fid(f.sketch), points: f.points.map(sub) });
      case 'pattern':
        return scoped({
          ...f,
          id,
          features: f.features.map(fid),
          layout:
            f.layout.type === 'linear'
              ? { ...f.layout, direction: ref(f.layout.direction) }
              : { ...f.layout, axis: ref(f.layout.axis) },
        });
      case 'mirror':
        return scoped({ ...f, id, features: f.features.map(fid), plane: ref(f.plane) });
      case 'extension':
        // `params` is opaque (ADR 0013 decision 2 keeps feature ids out of it).
        return scoped({
          ...f,
          id,
          dependsOn: f.dependsOn.map(fid),
          references: f.references.map(ref),
        });
      case 'import':
        return scoped({ ...f, id });
      case 'derived':
        // The source and its `bodies` are another document's: opaque.
        return scoped({ ...f, id });
      case 'thread':
        return {
          ...f,
          id,
          face: ref(f.face),
          ...(f.start !== undefined && { start: ref(f.start) }),
        };
    }
  }

  private profile<P extends { sketch: string; entities?: string[] | undefined }>(
    ps: ScopeKey,
    p: P,
  ): P {
    const out = { ...p, sketch: this.id(ps, p.sketch) };
    if (p.entities !== undefined) out.entities = p.entities.map((e) => this.sub(ps, e));
    return out;
  }

  private entity(ps: ScopeKey, e: SketchEntity): SketchEntity {
    const id = this.sub(ps, e.id);
    if (e.kind === 'outline' && e.source.kind === 'text') {
      return { ...e, id, source: { ...e.source, font: this.id(DOCUMENT_SCOPE, e.source.font) } };
    }
    return { ...e, id };
  }

  /** Sketch references: an entity id, or a built-in (`@origin`) left alone. */
  private sketchRef(ps: ScopeKey, ref: string): string {
    return ref.startsWith('@') ? ref : this.sub(ps, ref);
  }

  private constraint(ps: ScopeKey, c: SketchConstraint): SketchConstraint {
    const out: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(c)) {
      if (field === 'id') out[field] = this.sub(ps, v as string);
      else if (field === 'kind' || field === 'value' || field === 'at') out[field] = v;
      else if (typeof v === 'string') out[field] = this.sketchRef(ps, v);
      else if (v !== null && typeof v === 'object' && 'entity' in v) {
        const p = v as { entity: string };
        out[field] = { ...p, entity: this.sketchRef(ps, p.entity) };
      } else out[field] = v;
    }
    return out as unknown as SketchConstraint;
  }

  /** A whole part, its id in the document scope and everything inside in its own scope. */
  part(p: Part): Part {
    const ps = partScope(p.id);
    return {
      ...p,
      id: this.id(DOCUMENT_SCOPE, p.id),
      features: p.features.map((f) => this.feature(p.id, f)),
      nextIds: this.nextIds(ps, p.nextIds),
      bodies: p.bodies.map((b) => ({ ...b, id: this.body(p.id, b.id) })),
    };
  }

  // Configurations ---------------------------------------------------------------------------

  configParameter(p: ConfigParameter): ConfigParameter {
    const id = this.id(DOCUMENT_SCOPE, p.id);
    if (p.kind === 'variable') return { ...p, id };
    return {
      ...p,
      id,
      partId: this.id(DOCUMENT_SCOPE, p.partId),
      featureId: this.id(partScope(p.partId), p.featureId),
    };
  }

  configRow(r: ConfigRow): ConfigRow {
    const values: Record<string, ConfigRow['values'][string]> = {};
    for (const [k, v] of Object.entries(r.values)) values[this.id(DOCUMENT_SCOPE, k)] = v;
    return { ...r, id: this.id(DOCUMENT_SCOPE, r.id), values };
  }

  configurations(c: Configurations): Configurations {
    return {
      ...c,
      parameters: c.parameters.map((p) => this.configParameter(p)),
      rows: c.rows.map((r) => this.configRow(r)),
      active: c.active === null ? null : this.id(DOCUMENT_SCOPE, c.active),
    };
  }

  // Assemblies -------------------------------------------------------------------------------

  instanceSource<S extends InstanceSource>(s: S): S {
    if ('documentId' in s) return s; // pinned: another document
    const out = { ...s, part: this.id(DOCUMENT_SCOPE, s.part) };
    if (s.configuration !== undefined) out.configuration = this.id(DOCUMENT_SCOPE, s.configuration);
    return out;
  }

  instance(assemblyId: string, i: Instance): Instance {
    const part = 'part' in i.source ? i.source.part : undefined;
    const out: Instance = {
      ...i,
      id: this.id(assemblyScope(assemblyId), i.id),
      source: this.instanceSource(i.source),
    };
    if (i.bodies !== undefined) out.bodies = this.bodies(part, i.bodies);
    return out;
  }

  private connector(
    assemblyId: string,
    c: MateConnector,
    partOf: (instanceId: string) => string | undefined,
  ): MateConnector {
    const as = assemblyScope(assemblyId);
    const part = partOf(c.instance);
    return {
      ...c,
      id: this.id(as, c.id),
      instance: this.id(as, c.instance),
      origin: this.reference(as, part, c.origin),
    } as MateConnector;
  }

  mate(assemblyId: string, m: Mate, partOf: (instanceId: string) => string | undefined): Mate {
    return {
      ...m,
      id: this.id(assemblyScope(assemblyId), m.id),
      a: this.connector(assemblyId, m.a, partOf),
      b: this.connector(assemblyId, m.b, partOf),
    };
  }

  explodeStep(
    assemblyId: string,
    s: ExplodeStep,
    partOf: (instanceId: string) => string | undefined,
  ): ExplodeStep {
    const as = assemblyScope(assemblyId);
    const d = s.direction;
    let direction = d;
    if (!('vector' in d)) {
      const part = partOf(d.instance);
      direction =
        'edge' in d
          ? { ...d, instance: this.id(as, d.instance), edge: this.topo(part, d.edge) }
          : { ...d, instance: this.id(as, d.instance), face: this.topo(part, d.face) };
    }
    return {
      ...s,
      id: this.id(as, s.id),
      instances: s.instances.map((i) => this.id(as, i)),
      direction,
    };
  }

  explodedView(
    assemblyId: string,
    v: ExplodedView,
    partOf: (instanceId: string) => string | undefined,
  ): ExplodedView {
    return {
      ...v,
      id: this.id(assemblyScope(assemblyId), v.id),
      steps: v.steps.map((s) => this.explodeStep(assemblyId, s, partOf)),
    };
  }

  assembly(a: Assembly): Assembly {
    const local = new Map(
      a.instances.map((i) => [i.id, 'part' in i.source ? i.source.part : undefined] as const),
    );
    const partOf = (id: string) => local.get(id);
    const out: Assembly = {
      ...a,
      id: this.id(DOCUMENT_SCOPE, a.id),
      instances: a.instances.map((i) => this.instance(a.id, i)),
      mates: a.mates.map((m) => this.mate(a.id, m, partOf)),
      nextIds: this.nextIds(assemblyScope(a.id), a.nextIds),
    };
    if (a.explodedViews !== undefined) {
      out.explodedViews = a.explodedViews.map((v) => this.explodedView(a.id, v, partOf)) as [
        ExplodedView,
        ...ExplodedView[],
      ];
    }
    return out;
  }

  /** The resolver's view of an instance's part, for commands that do not carry the assembly. */
  partOfInstance(assemblyId: string): (instanceId: string) => string | undefined {
    return (id) => this.resolver.instancePart(assemblyId, id);
  }

  // Print ------------------------------------------------------------------------------------

  printItem(item: PrintItem): PrintItem {
    const part = item.part;
    const out: PrintItem = {
      ...item,
      id: this.id(PRINT_SCOPE, item.id),
      part: this.id(DOCUMENT_SCOPE, part),
      orientation:
        item.orientation.kind === 'layFlat'
          ? {
              ...item.orientation,
              face: this.reference(PRINT_SCOPE, part, item.orientation.face),
            }
          : item.orientation,
    };
    if (item.body !== undefined) out.body = this.body(part, item.body);
    return out;
  }

  printSetup(s: PrintSetup): PrintSetup {
    return {
      ...s,
      id: this.id(PRINT_SCOPE, s.id),
      items: s.items.map((i) => this.printItem(i)),
    };
  }

  print(p: PrintData): PrintData {
    return {
      ...p,
      setups: p.setups.map((s) => this.printSetup(s)),
      nextIds: this.nextIds(PRINT_SCOPE, p.nextIds),
    };
  }

  font(f: DocumentFont): DocumentFont {
    return { ...f, id: this.id(DOCUMENT_SCOPE, f.id) };
  }

  // CAM --------------------------------------------------------------------------------------

  camWcs(part: string | undefined, w: CamWcs): CamWcs {
    if (w.up.kind !== 'face') return w;
    return { ...w, up: { ...w.up, face: this.reference(CAM_SCOPE, part, w.up.face) } };
  }

  camOperation(part: string | undefined, o: CamOperation): CamOperation {
    const ps = part === undefined ? undefined : partScope(part);
    const inPart = (id: string, sub: boolean): string => {
      if (ps === undefined) {
        this.report.unresolved++;
        return id;
      }
      return sub ? this.sub(ps, id) : this.id(ps, id);
    };
    const geometry = o.geometry.map((g): CamOperation['geometry'][number] => {
      switch (g.kind) {
        case 'face':
          return { ...g, face: this.reference(CAM_SCOPE, part, g.face) };
        case 'region': {
          const out = { ...g, sketch: inPart(g.sketch, false) as typeof g.sketch };
          if (g.entities !== undefined) out.entities = g.entities.map((e) => inPart(e, true));
          return out;
        }
        case 'hole':
          return { ...g, feature: inPart(g.feature, false) as typeof g.feature };
      }
    });
    const out = {
      ...o,
      id: this.id(CAM_SCOPE, o.id),
      tool: this.id(CAM_SCOPE, o.tool),
      geometry,
    } as CamOperation;
    if (out.kind === 'vcarve' && out.clearing !== undefined) {
      out.clearing = { ...out.clearing, tool: this.id(CAM_SCOPE, out.clearing.tool) };
    }
    return out;
  }

  camSetup(s: CamSetup): CamSetup {
    const out: CamSetup = {
      ...s,
      id: this.id(CAM_SCOPE, s.id),
      part: this.id(DOCUMENT_SCOPE, s.part),
      wcs: this.camWcs(s.part, s.wcs),
      operations: s.operations.map((o) => this.camOperation(s.part, o)),
    };
    if (s.body !== undefined) out.body = this.body(s.part, s.body);
    return out;
  }

  cam(c: CamData): CamData {
    return {
      ...c,
      tools: c.tools.map((t) => ({ ...t, id: this.id(CAM_SCOPE, t.id) })),
      setups: c.setups.map((s) => this.camSetup(s)),
      nextIds: this.nextIds(CAM_SCOPE, c.nextIds),
    };
  }

  // Drawings ---------------------------------------------------------------------------------

  viewSource(s: ViewSource): ViewSource {
    if ('domain' in s) return { ...s, part: this.id(DOCUMENT_SCOPE, s.part) };
    if ('assembly' in s) {
      const out = { ...s, assembly: this.id(DOCUMENT_SCOPE, s.assembly) };
      if (s.explodedView !== undefined) {
        out.explodedView = this.id(assemblyScope(s.assembly), s.explodedView);
      }
      return out;
    }
    const out = { ...s, part: this.id(DOCUMENT_SCOPE, s.part) };
    if (s.bodies !== undefined) out.bodies = this.bodies(s.part, s.bodies);
    return out;
  }

  view(drawingId: string, v: DrawingView): DrawingView {
    return { ...v, id: this.id(drawingScope(drawingId), v.id), source: this.viewSource(v.source) };
  }

  private dimensionRef(source: ViewSource | undefined, r: DimensionRef): DimensionRef {
    let part: string | undefined;
    let instance: string[] | undefined;
    if (source === undefined) part = undefined;
    else if ('assembly' in source) {
      const path = r.instance ?? [];
      const last = path[path.length - 1];
      part = last === undefined ? undefined : this.resolver.instancePart(source.assembly, last);
      if (r.instance !== undefined) {
        instance = r.instance.map((i) => this.id(assemblyScope(source.assembly), i));
      }
    } else part = source.part;
    const out = { ...r, body: this.body(part, r.body) } as DimensionRef;
    if (instance !== undefined) out.instance = instance;
    if ('face' in r) (out as { face: unknown }).face = this.topo(part, r.face);
    else if ('edge' in r) (out as { edge: unknown }).edge = this.topo(part, r.edge);
    else (out as { vertex: unknown }).vertex = this.topo(part, r.vertex);
    return out;
  }

  dimension(drawingId: string, d: Dimension, source: ViewSource | undefined): Dimension {
    const ds = drawingScope(drawingId);
    return {
      ...d,
      id: this.id(ds, d.id),
      view: this.id(ds, d.view),
      refs: d.refs.map((r) => this.dimensionRef(source, r)),
    } as Dimension;
  }

  note(drawingId: string, n: Note): Note {
    const ds = drawingScope(drawingId);
    const out: Note = { ...n, id: this.id(ds, n.id) };
    if (n.view !== undefined) out.view = this.id(ds, n.view);
    return out;
  }

  sheet(drawingId: string, s: Sheet): Sheet {
    const local = new Map(s.views.map((v) => [v.id, v.source] as const));
    const sourceOf = (viewId: string) =>
      local.get(viewId) ?? this.resolver.viewSource(drawingId, viewId);
    return {
      ...s,
      id: this.id(drawingScope(drawingId), s.id),
      views: s.views.map((v) => this.view(drawingId, v)),
      dimensions: s.dimensions.map((d) => this.dimension(drawingId, d, sourceOf(d.view))),
      notes: s.notes.map((n) => this.note(drawingId, n)),
    };
  }

  drawing(d: Drawing): Drawing {
    return {
      ...d,
      id: this.id(DOCUMENT_SCOPE, d.id),
      sheets: d.sheets.map((s) => this.sheet(d.id, s)),
      nextIds: this.nextIds(drawingScope(d.id), d.nextIds),
    };
  }

  // Documents and commands -------------------------------------------------------------------

  /** A whole document: every id in every scope. Its own `id`, variables and domains stay. */
  document(doc: ManufaktureDocument): ManufaktureDocument {
    const inner = new IdWalker(this.visit, new QueueResolver(doc), this.report, this.counters);
    const out: ManufaktureDocument = {
      ...doc,
      parts: doc.parts.map((p) => inner.part(p)),
      assemblies: doc.assemblies.map((a) => inner.assembly(a)),
      print: inner.print(doc.print),
      fonts: doc.fonts.map((f) => inner.font(f)),
      cam: inner.cam(doc.cam),
      nextIds: inner.nextIds(DOCUMENT_SCOPE, doc.nextIds),
    };
    if (doc.drawings !== undefined) {
      out.drawings = doc.drawings.map((d) => inner.drawing(d)) as [Drawing, ...Drawing[]];
    }
    if (doc.configurations !== undefined) {
      out.configurations = inner.configurations(doc.configurations);
    }
    return out;
  }

  command(c: Command): Command {
    if (c.type === 'batch') {
      return { ...c, commands: c.commands.map((x) => this.command(x)) };
    }
    return this.simple(c);
  }

  private simple(c: SimpleCommand): SimpleCommand {
    const doc = (id: string) => this.id(DOCUMENT_SCOPE, id);
    switch (c.type) {
      case 'addFeature':
      case 'editFeature':
      case 'restoreFeature':
        return { ...c, partId: doc(c.partId), feature: this.feature(c.partId, c.feature) };
      case 'deleteFeature':
      case 'reorderFeature':
      case 'suppressFeature':
      case 'renameFeature':
        return {
          ...c,
          partId: doc(c.partId),
          featureId: this.id(partScope(c.partId), c.featureId),
        };
      case 'setMaterial':
      case 'setRollback':
      case 'addPart':
      case 'renamePart':
      case 'deletePart':
      case 'reorderParts':
        return { ...c, partId: doc(c.partId) };
      case 'setBodyProps':
        return { ...c, partId: doc(c.partId), bodyId: this.body(c.partId, c.bodyId) };
      case 'setVariable':
      case 'deleteVariable':
      case 'setDisplayUnits':
      case 'renameDocument':
      case 'setDomainData':
        return c;
      case 'setConfigParameter':
      case 'restoreConfigParameter':
        return { ...c, parameter: this.configParameter(c.parameter) };
      case 'deleteConfigParameter':
        return { ...c, parameterId: doc(c.parameterId) };
      case 'setConfigRow':
      case 'restoreConfigRow':
        return { ...c, row: this.configRow(c.row) };
      case 'deleteConfigRow':
        return { ...c, rowId: doc(c.rowId) };
      case 'setActiveConfiguration':
        return { ...c, rowId: c.rowId === null ? null : doc(c.rowId) };
      case 'restorePart':
        return { ...c, part: this.part(c.part) };
      case 'duplicatePart':
        return { ...c, sourcePartId: doc(c.sourcePartId), partId: doc(c.partId) };
      case 'addAssembly':
      case 'renameAssembly':
      case 'deleteAssembly':
        return { ...c, assemblyId: doc(c.assemblyId) };
      case 'restoreAssembly':
        return { ...c, assembly: this.assembly(c.assembly) };
      case 'addInstance':
      case 'restoreInstance':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          instance: this.instance(c.assemblyId, c.instance),
        };
      case 'editInstance': {
        const as = assemblyScope(c.assemblyId);
        const out = { ...c, assemblyId: doc(c.assemblyId), instanceId: this.id(as, c.instanceId) };
        const part =
          c.source !== undefined
            ? 'part' in c.source
              ? c.source.part
              : undefined
            : this.resolver.instancePart(c.assemblyId, c.instanceId);
        if (c.bodies !== undefined && c.bodies !== null) {
          out.bodies = this.bodies(part, c.bodies) as typeof c.bodies;
        }
        if (c.source !== undefined) out.source = this.instanceSource(c.source);
        return out;
      }
      case 'setPoses': {
        const as = assemblyScope(c.assemblyId);
        const poses: typeof c.poses = {};
        for (const [k, v] of Object.entries(c.poses)) poses[this.id(as, k)] = v;
        return { ...c, assemblyId: doc(c.assemblyId), poses };
      }
      case 'deleteInstance':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          instanceId: this.id(assemblyScope(c.assemblyId), c.instanceId),
        };
      case 'addMate':
      case 'editMate':
      case 'restoreMate':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          mate: this.mate(c.assemblyId, c.mate, this.partOfInstance(c.assemblyId)),
        };
      case 'deleteMate':
      case 'suppressMate':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          mateId: this.id(assemblyScope(c.assemblyId), c.mateId),
        };
      case 'addPrintSetup':
      case 'restorePrintSetup':
        return { ...c, setup: this.printSetup(c.setup) };
      case 'editPrintSetup':
      case 'deletePrintSetup':
        return { ...c, setupId: this.id(PRINT_SCOPE, c.setupId) };
      case 'addPrintItem':
      case 'editPrintItem':
      case 'restorePrintItem':
        return { ...c, setupId: this.id(PRINT_SCOPE, c.setupId), item: this.printItem(c.item) };
      case 'deletePrintItem':
        return {
          ...c,
          setupId: this.id(PRINT_SCOPE, c.setupId),
          itemId: this.id(PRINT_SCOPE, c.itemId),
        };
      case 'addFont':
      case 'restoreFont':
        return { ...c, font: this.font(c.font) };
      case 'deleteFont':
        return { ...c, fontId: doc(c.fontId) };
      case 'addExplodedView':
      case 'editExplodedView':
      case 'restoreExplodedView':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          explodedView: this.explodedView(
            c.assemblyId,
            c.explodedView,
            this.partOfInstance(c.assemblyId),
          ),
        };
      case 'deleteExplodedView':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          explodedViewId: this.id(assemblyScope(c.assemblyId), c.explodedViewId),
        };
      case 'addExplodeStep':
      case 'editExplodeStep':
      case 'restoreExplodeStep':
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          explodedViewId: this.id(assemblyScope(c.assemblyId), c.explodedViewId),
          step: this.explodeStep(c.assemblyId, c.step, this.partOfInstance(c.assemblyId)),
        };
      case 'deleteExplodeStep': {
        const as = assemblyScope(c.assemblyId);
        return {
          ...c,
          assemblyId: doc(c.assemblyId),
          explodedViewId: this.id(as, c.explodedViewId),
          stepId: this.id(as, c.stepId),
        };
      }
      case 'addDrawing':
      case 'restoreDrawing':
        return { ...c, drawing: this.drawing(c.drawing) };
      case 'renameDrawing':
      case 'deleteDrawing':
      case 'reorderDrawings':
        return { ...c, drawingId: doc(c.drawingId) };
      case 'addSheet':
      case 'restoreSheet':
        return { ...c, drawingId: doc(c.drawingId), sheet: this.sheet(c.drawingId, c.sheet) };
      case 'editSheet':
      case 'deleteSheet':
      case 'reorderSheets':
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(drawingScope(c.drawingId), c.sheetId),
        };
      case 'addView':
      case 'editView':
      case 'restoreView':
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(drawingScope(c.drawingId), c.sheetId),
          view: this.view(c.drawingId, c.view),
        };
      case 'moveView':
      case 'deleteView': {
        const ds = drawingScope(c.drawingId);
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(ds, c.sheetId),
          viewId: this.id(ds, c.viewId),
        };
      }
      case 'addDimension':
      case 'editDimension':
      case 'restoreDimension':
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(drawingScope(c.drawingId), c.sheetId),
          dimension: this.dimension(
            c.drawingId,
            c.dimension,
            this.resolver.viewSource(c.drawingId, c.dimension.view),
          ),
        };
      case 'deleteDimension': {
        const ds = drawingScope(c.drawingId);
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(ds, c.sheetId),
          dimensionId: this.id(ds, c.dimensionId),
        };
      }
      case 'addNote':
      case 'editNote':
      case 'restoreNote':
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(drawingScope(c.drawingId), c.sheetId),
          note: this.note(c.drawingId, c.note),
        };
      case 'deleteNote': {
        const ds = drawingScope(c.drawingId);
        return {
          ...c,
          drawingId: doc(c.drawingId),
          sheetId: this.id(ds, c.sheetId),
          noteId: this.id(ds, c.noteId),
        };
      }
      case 'addCamTool':
      case 'editCamTool':
      case 'restoreCamTool':
        return { ...c, tool: { ...c.tool, id: this.id(CAM_SCOPE, c.tool.id) } };
      case 'deleteCamTool':
        return { ...c, toolId: this.id(CAM_SCOPE, c.toolId) };
      case 'addCamSetup':
      case 'restoreCamSetup':
        return { ...c, setup: this.camSetup(c.setup) };
      case 'editCamSetup': {
        const part = c.part ?? this.resolver.setupPart(c.setupId);
        const out = { ...c, setupId: this.id(CAM_SCOPE, c.setupId) };
        if (c.part !== undefined) out.part = doc(c.part);
        if (c.body !== undefined && c.body !== null) out.body = this.body(part, c.body);
        if (c.wcs !== undefined) out.wcs = this.camWcs(part, c.wcs);
        return out;
      }
      case 'deleteCamSetup':
      case 'reorderCamSetups':
        return { ...c, setupId: this.id(CAM_SCOPE, c.setupId) };
      case 'addCamOperation':
      case 'editCamOperation':
      case 'restoreCamOperation':
        return {
          ...c,
          setupId: this.id(CAM_SCOPE, c.setupId),
          operation: this.camOperation(this.resolver.setupPart(c.setupId), c.operation),
        };
      case 'deleteCamOperation':
      case 'reorderCamOperation':
      case 'suppressCamOperation':
        return {
          ...c,
          setupId: this.id(CAM_SCOPE, c.setupId),
          operationId: this.id(CAM_SCOPE, c.operationId),
        };
      case 'replaceDocument':
        return { ...c, document: this.document(c.document) };
    }
  }
}

/** A visitor that renames through `table` and counts into `report`. */
function tableVisitor(table: RenameTable, report: RemapReport): IdVisitor {
  return (scope, id, inName) => {
    const renames = Object.hasOwn(table, scope) ? table[scope] : undefined;
    if (renames === undefined || !Object.hasOwn(renames, id)) return id;
    const to = renames[id];
    report.renamed++;
    return to === null || to === undefined ? tombstoneId(id, inName) : to;
  };
}

function counterRaiser(
  table: RenameTable,
): (scope: ScopeKey, nextIds: Record<string, number>) => Record<string, number> {
  return (scope, nextIds) =>
    raiseCounters(nextIds, Object.hasOwn(table, scope) ? table[scope] : undefined);
}

function isEmpty(table: RenameTable): boolean {
  return Object.values(table).every((t) => Object.keys(t).length === 0);
}

/**
 * Rewrites the ids of `commands` through one table (ADR 0009 amendment, item 6): every command
 * in the list, in order, with the same renames, so a queue, its undo stack's inverses or its redo
 * entries can each be rewritten in one call. The table and the commands are in the same naming
 * (the client's current one); scopes are keyed by old ids. Counters carried inside commands (a
 * restored part's, a replaced document's) are raised so they still cover every id they covered
 * (past the new id of each renamed id below them), so they stay valid. Pure; the input is not changed, and an empty table returns it as it is.
 *
 * Commands must be valid (schema-shaped); see `RemapOptions` for resolving names of another part.
 */
export function remapIds(
  commands: readonly Command[],
  table: RenameTable,
  options: RemapOptions = {},
): Command[] {
  if (isEmpty(table)) return [...commands];
  const report = options.report ?? emptyRemapReport();
  const resolver = new QueueResolver(options.document);
  const walker = new IdWalker(tableVisitor(table, report), resolver, report, counterRaiser(table));
  return commands.map((c) => {
    const out = walker.command(c);
    resolver.learn(c);
    return out;
  });
}

/**
 * Renames every id of a document, in every scope, inside names too, and raises each scope's
 * counters past the new ids. `applyCommand(remapDocument(d, t), remapIds([c], t)[0])` gives
 * `remapDocument(applyCommand(d, c), t)` whenever the table only renames into fresh numbers.
 */
export function remapDocument(
  doc: ManufaktureDocument,
  table: RenameTable,
  report: RemapReport = emptyRemapReport(),
): ManufaktureDocument {
  if (isEmpty(table)) return doc;
  const walker = new IdWalker(
    tableVisitor(table, report),
    new QueueResolver(doc),
    report,
    counterRaiser(table),
  );
  return walker.document(doc);
}

/**
 * Every id in plain fields of `commands` (not inside names), with its scope, in walk order. The
 * document resolves names of other parts; plain fields never need it except for CAM region and
 * hole fields, which name their setup's part.
 */
export function commandIds(
  commands: readonly Command[],
  document?: ManufaktureDocument,
): { scope: ScopeKey; id: string }[] {
  const out: { scope: ScopeKey; id: string }[] = [];
  const report = emptyRemapReport();
  const resolver = new QueueResolver(document);
  const walker = new IdWalker(
    (scope, id, inName) => {
      if (!inName) out.push({ scope, id });
      return id;
    },
    resolver,
    report,
  );
  for (const c of commands) {
    walker.command(c);
    resolver.learn(c);
  }
  return out;
}

/** Whether `to` may replace `from` in a table: both ids of the same counter (or a tombstone). */
export function isValidRename(from: string, to: string | null): boolean {
  const a = idCounter(from);
  if (a === undefined || a.split !== '') return false;
  if (to === null) return true;
  const b = idCounter(to);
  return b !== undefined && b.split === '' && b.counter === a.counter;
}
