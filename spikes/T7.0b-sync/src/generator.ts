// Random commands against a client's visible document: every M1 feature kind (sketch, extrude,
// fillet, chamfer, shell, hole, pattern, mirror), edits, delete, reorder, suppress, rollback,
// variables, batches and replaceDocument, plus the other counter scopes (parts, assemblies with
// instances and mates, configurations, CAM tools, setups and operations). Each command is tried
// locally with applyCommand and only a command that applies is returned, as a user can only make
// commands that apply to what they see.

import {
  applyCommand,
  restoredDocument,
  type CamOperation,
  type Command,
  type ExtrudeFeature,
  type Feature,
  type ManufaktureDocument,
  type MateConnector,
  type Part,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { featureSignature, namesSignature, tagOf } from './intent.ts';
import type { Rng } from './rng.ts';

export interface Generated {
  command: Command;
  label: string;
  category: string;
  /** For a restore: the past document it restores. */
  restoreOf?: ManufaktureDocument;
}

export interface GenOptions {
  /** Relative weight per category; absent categories use the defaults. */
  weights?: Partial<Record<Category, number>>;
}

const DEFAULT_WEIGHTS = {
  sketch: 10,
  extrude: 10,
  fillet: 5,
  chamfer: 4,
  shell: 2,
  hole: 2,
  pattern: 3,
  mirror: 3,
  editExtrude: 6,
  editSketch: 6,
  editFillet: 2,
  delete: 5,
  reorder: 4,
  suppress: 4,
  rollback: 2,
  setVariable: 4,
  deleteVariable: 1,
  batch: 4,
  replaceDocument: 1,
  addPart: 1,
  duplicatePart: 0.5,
  addAssembly: 1,
  addInstance: 2,
  addMate: 2,
  configParameter: 1.5,
  configRow: 1,
  camTool: 0.7,
  camSetup: 1,
  camOperation: 2,
};
export type Category = keyof typeof DEFAULT_WEIGHTS;

const mm = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } as const;

/** Hands out ids from a copy of a `nextIds`, so one command can take several. */
class Alloc {
  private readonly next: Record<string, number>;
  constructor(nextIds: Readonly<Record<string, number>>) {
    this.next = { ...nextIds };
  }
  take(counter: string): string {
    const n = this.next[counter] ?? 1;
    this.next[counter] = n + 1;
    return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
  }
}

export class Generator {
  private readonly rng: Rng;
  private readonly client: number;
  private items = 0;
  private coords = 0;
  private readonly weights: Record<Category, number>;
  /** Earlier confirmed documents this client saw, for replaceDocument (a restore). */
  readonly history: ManufaktureDocument[] = [];
  private restoreOf: ManufaktureDocument | undefined;

  constructor(rng: Rng, client: number, options: GenOptions = {}) {
    this.rng = rng;
    this.client = client;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  }

  private tag(): string {
    return `c${this.client}.${++this.items}`;
  }

  /** A coordinate no other entity of any client has, so entity signatures are unique. */
  private uniq(): number {
    return this.client * 100_000 + ++this.coords * 50;
  }

  private category(): Category {
    const entries = Object.entries(this.weights) as Array<[Category, number]>;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let x = this.rng.next() * total;
    for (const [c, w] of entries) {
      x -= w;
      if (x < 0) return c;
    }
    return entries[0]![0];
  }

  generate(doc: ManufaktureDocument): Generated | undefined {
    for (let attempt = 0; attempt < 30; attempt++) {
      const category = this.category();
      this.restoreOf = undefined;
      const command = this.make(category, doc);
      if (command === undefined) continue;
      if (applyCommand(doc, command).ok) {
        const g: Generated = { command, label: category, category };
        if (this.restoreOf) g.restoreOf = this.restoreOf;
        return g;
      }
    }
    return undefined;
  }

  private part(doc: ManufaktureDocument): Part {
    const withFeatures = doc.parts.filter((p) => p.features.length > 0);
    return this.rng.chance(0.85) && withFeatures.length > 0
      ? this.rng.pick(withFeatures)
      : this.rng.pick(doc.parts);
  }

  private named<F extends Feature>(part: Part, feature: F, tag: string, extra: Feature[] = []): F {
    const scratch: Part = { ...part, features: [...part.features, ...extra] };
    return { ...feature, name: `${tag}>${featureSignature(scratch, feature)}` };
  }

  private extrudes(part: Part): ExtrudeFeature[] {
    return part.features.filter((f): f is ExtrudeFeature => f.kind === 'extrude');
  }

  private sketchOf(part: Part, e: ExtrudeFeature): SketchFeature | undefined {
    const s = part.features.find((f) => f.id === e.profile.sketch);
    return s?.kind === 'sketch' ? s : undefined;
  }

  /** Two line entities of an extrude's sketch, for an edge between two side faces. */
  private sideEdge(part: Part): [ExtrudeFeature, string, string] | undefined {
    const candidates = this.extrudes(part).filter((e) => {
      const s = this.sketchOf(part, e);
      return s !== undefined && s.entities.filter((x) => x.kind === 'line').length >= 2;
    });
    if (candidates.length === 0) return undefined;
    const e = this.rng.pick(candidates);
    const lines = this.sketchOf(part, e)!.entities.filter((x) => x.kind === 'line');
    const i = this.rng.int(lines.length);
    const a = lines[i]!.id;
    const b = lines[(i + 1) % lines.length]!.id;
    return [e, a, b];
  }

  private sketch(part: Part, alloc: Alloc, points = false): SketchFeature {
    const id = alloc.take('sketch');
    const ext = this.extrudes(part);
    const plane: SketchFeature['plane'] =
      ext.length > 0 && this.rng.chance(0.5)
        ? {
            type: 'face',
            face: { id: alloc.take('r'), ref: { face: `${this.rng.pick(ext).id}:cap:end` } },
          }
        : {
            type: 'plane',
            origin: [0, 0, this.rng.int(50)],
            normal: [0, 0, 1],
            xDir: [1, 0, 0],
          };
    if (points) {
      const entities = [0, 1, 2].map(() => ({
        id: alloc.take('e'),
        kind: 'point' as const,
        construction: false,
        position: [this.uniq(), 5] as [number, number],
      }));
      return { id, kind: 'sketch', name: id, suppressed: false, plane, entities, constraints: [] };
    }
    const x = this.uniq();
    const pts: Array<[number, number]> = [
      [x, 0],
      [x + 40, 0.5],
      [x + 39, 20],
      [x + 1, 19.5],
    ];
    const entities = pts.map((p, i) => ({
      id: alloc.take('e'),
      kind: 'line' as const,
      construction: false,
      start: p,
      end: pts[(i + 1) % 4]!,
    }));
    const constraints: SketchFeature['constraints'] = [
      {
        id: alloc.take('k'),
        kind: 'coincident',
        a: { entity: entities[0]!.id, at: 'end' },
        b: { entity: entities[1]!.id, at: 'start' },
      },
      { id: alloc.take('k'), kind: 'horizontal', line: entities[0]!.id },
    ];
    return { id, kind: 'sketch', name: id, suppressed: false, plane, entities, constraints };
  }

  private extrude(part: Part, alloc: Alloc, sketch: SketchFeature): ExtrudeFeature {
    const op = this.rng.pick(['new', 'new', 'add', 'cut'] as const);
    const vars = ['thickness', 'width'];
    return {
      id: alloc.take('extrude'),
      kind: 'extrude',
      name: 'x',
      suppressed: false,
      profile: { sketch: sketch.id },
      operation: op,
      extent: this.rng.chance(0.3)
        ? { type: 'throughAll' }
        : { type: 'blind', distance: mm(this.rng.chance(0.5) ? this.rng.pick(vars) : '5') },
      reverse: this.rng.chance(0.2),
    };
  }

  private make(category: Category, doc: ManufaktureDocument): Command | undefined {
    const rng = this.rng;
    const part = this.part(doc);
    const partId = part.id;
    const alloc = new Alloc(part.nextIds);
    const add = (feature: Feature): Command => ({ type: 'addFeature', partId, feature });
    switch (category) {
      case 'sketch': {
        const s = this.sketch(part, alloc, rng.chance(0.25));
        return add(this.named(part, s, this.tag()));
      }
      case 'extrude': {
        const sketches = part.features.filter(
          (f): f is SketchFeature =>
            f.kind === 'sketch' && f.entities.some((e) => e.kind === 'line'),
        );
        if (sketches.length === 0) return undefined;
        return add(this.named(part, this.extrude(part, alloc, rng.pick(sketches)), this.tag()));
      }
      case 'fillet':
      case 'chamfer': {
        const edge = this.sideEdge(part);
        if (!edge) return undefined;
        const [e, a, b] = edge;
        const faces = [`${e.id}:side:${a}`, `${e.id}:side:${b}`].sort();
        const edges = [{ id: alloc.take('r'), ref: { faces } }];
        const f: Feature =
          category === 'fillet'
            ? {
                id: alloc.take('fillet'),
                kind: 'fillet',
                name: 'x',
                suppressed: false,
                edges,
                radius: mm('1'),
              }
            : {
                id: alloc.take('chamfer'),
                kind: 'chamfer',
                name: 'x',
                suppressed: false,
                edges,
                distance: mm('1'),
                ...(rng.chance(0.5) && { secondDistance: mm('2') }),
              };
        return add(this.named(part, f, this.tag()));
      }
      case 'shell': {
        const ext = this.extrudes(part);
        if (ext.length === 0) return undefined;
        const e = rng.pick(ext);
        return add(
          this.named(
            part,
            {
              id: alloc.take('shell'),
              kind: 'shell',
              name: 'x',
              suppressed: false,
              faces: [{ id: alloc.take('r'), ref: { face: `${e.id}:cap:end` } }],
              thickness: mm('1'),
              outward: false,
            },
            this.tag(),
          ),
        );
      }
      case 'hole': {
        const sketches = part.features.filter(
          (f): f is SketchFeature =>
            f.kind === 'sketch' && f.entities.some((e) => e.kind === 'point'),
        );
        if (sketches.length === 0) return undefined;
        const s = rng.pick(sketches);
        const points = s.entities.filter((e) => e.kind === 'point').map((e) => e.id);
        return add(
          this.named(
            part,
            {
              id: alloc.take('hole'),
              kind: 'hole',
              name: 'x',
              suppressed: false,
              sketch: s.id,
              points: points.slice(0, 1 + rng.int(points.length)),
              diameter: mm('3'),
              extent: { type: 'throughAll' },
              head: { type: 'simple' },
            },
            this.tag(),
          ),
        );
      }
      case 'pattern':
      case 'mirror': {
        const edge = this.sideEdge(part);
        if (!edge) return undefined;
        const [e, a, b] = edge;
        const f: Feature =
          category === 'pattern'
            ? {
                id: alloc.take('pattern'),
                kind: 'pattern',
                name: 'x',
                suppressed: false,
                features: [e.id],
                layout: {
                  type: 'linear',
                  direction: {
                    id: alloc.take('r'),
                    ref: { faces: [`${e.id}:side:${a}`, `${e.id}:side:${b}`].sort() },
                  },
                  count: mm('3'),
                  spacing: mm('10'),
                },
              }
            : {
                id: alloc.take('mirror'),
                kind: 'mirror',
                name: 'x',
                suppressed: false,
                features: [e.id],
                plane: { id: alloc.take('r'), ref: { face: `${e.id}:side:${a}` } },
              };
        return add(this.named(part, f, this.tag()));
      }
      case 'editExtrude': {
        const ext = this.extrudes(part);
        if (ext.length === 0) return undefined;
        const e = rng.pick(ext);
        const feature: ExtrudeFeature = {
          ...e,
          extent: { type: 'blind', distance: mm(String(1 + rng.int(20))) },
          reverse: !e.reverse,
        };
        return { type: 'editFeature', partId, feature };
      }
      case 'editSketch': {
        // Adds a line (a fresh e id) and a constraint on it (a fresh k id).
        const sketches = part.features.filter((f): f is SketchFeature => f.kind === 'sketch');
        if (sketches.length === 0) return undefined;
        const s = rng.pick(sketches);
        const x = this.uniq();
        const line = {
          id: alloc.take('e'),
          kind: 'line' as const,
          construction: true,
          start: [x, 30] as [number, number],
          end: [x + 5, 30] as [number, number],
        };
        const feature: SketchFeature = {
          ...s,
          entities: [...s.entities, line],
          constraints: [
            ...s.constraints,
            { id: alloc.take('k'), kind: 'horizontal', line: line.id },
          ],
        };
        return { type: 'editFeature', partId, feature };
      }
      case 'editFillet': {
        const fs = part.features.filter((f) => f.kind === 'fillet');
        if (fs.length === 0) return undefined;
        const f = rng.pick(fs);
        if (f.kind !== 'fillet') return undefined;
        return {
          type: 'editFeature',
          partId,
          feature: { ...f, radius: mm(String(rng.int(5) + 1)) },
        };
      }
      case 'delete': {
        if (part.features.length === 0) return undefined;
        return { type: 'deleteFeature', partId, featureId: rng.pick(part.features).id };
      }
      case 'reorder': {
        if (part.features.length < 2) return undefined;
        return {
          type: 'reorderFeature',
          partId,
          featureId: rng.pick(part.features).id,
          index: rng.int(part.features.length),
        };
      }
      case 'suppress': {
        if (part.features.length === 0) return undefined;
        const f = rng.pick(part.features);
        return { type: 'suppressFeature', partId, featureId: f.id, suppressed: !f.suppressed };
      }
      case 'rollback': {
        const n = part.features.length;
        return { type: 'setRollback', partId, index: rng.chance(0.4) ? null : rng.int(n + 1) };
      }
      case 'setVariable': {
        const fresh = rng.chance(0.5);
        const name =
          fresh || doc.variables.length === 0
            ? `v${this.client}_${rng.int(6)}`
            : rng.pick(doc.variables).name;
        return { type: 'setVariable', name, expression: mm(String(1 + rng.int(30))) };
      }
      case 'deleteVariable': {
        if (doc.variables.length === 0) return undefined;
        return { type: 'deleteVariable', name: rng.pick(doc.variables).name };
      }
      case 'batch': {
        if (rng.chance(0.6)) {
          // A sketch and its extrude: the extrude names an id the same batch creates.
          const s = this.named(part, this.sketch(part, alloc), this.tag());
          const e = this.named(part, this.extrude(part, alloc, s), this.tag(), [s]);
          return { type: 'batch', commands: [add(s), add(e)] };
        }
        const a = this.make(rng.pick(['setVariable', 'suppress', 'editExtrude'] as const), doc);
        const b = this.make('setVariable', doc);
        if (!a || !b || a.type === 'batch' || b.type === 'batch') return undefined;
        return { type: 'batch', commands: [a, b] };
      }
      case 'replaceDocument': {
        if (this.history.length < 2) return undefined;
        const past = this.history[rng.int(this.history.length - 1)]!;
        this.restoreOf = past;
        return { type: 'replaceDocument', document: restoredDocument(doc, past) };
      }
      case 'addPart': {
        const id = new Alloc(doc.nextIds).take('part');
        return { type: 'addPart', partId: id, name: this.tag() };
      }
      case 'duplicatePart': {
        const id = new Alloc(doc.nextIds).take('part');
        return { type: 'duplicatePart', sourcePartId: partId, partId: id, name: this.tag() };
      }
      case 'addAssembly': {
        const id = new Alloc(doc.nextIds).take('assembly');
        return { type: 'addAssembly', assemblyId: id, name: this.tag() };
      }
      case 'addInstance': {
        if (doc.assemblies.length === 0) return undefined;
        const a = rng.pick(doc.assemblies);
        const target = this.part(doc);
        return {
          type: 'addInstance',
          assemblyId: a.id,
          instance: {
            id: new Alloc(a.nextIds).take('inst'),
            name: `${this.tag()}>${tagOf(target.name)}`,
            source: { part: target.id },
            fixed: a.instances.length === 0,
            suppressed: false,
            pose: IDENTITY,
          },
        };
      }
      case 'addMate': {
        const as = doc.assemblies.filter((a) => a.instances.length >= 2);
        if (as.length === 0) return undefined;
        const a = rng.pick(as);
        const aAlloc = new Alloc(a.nextIds);
        const [i1, i2] = [a.instances[0]!, a.instances[1 + rng.int(a.instances.length - 1)]!];
        const sigs: string[] = [];
        const connector = (inst: (typeof a.instances)[number]): MateConnector | undefined => {
          const src = inst.source;
          const p = 'part' in src ? doc.parts.find((x) => x.id === src.part) : undefined;
          if (!p) return undefined;
          const edge = this.sideEdge(p);
          const face = edge ? `${edge[0].id}:side:${edge[1]}` : undefined;
          if (!face) return undefined;
          sigs.push(namesSignature(p, [face], []));
          return {
            id: aAlloc.take('mc'),
            instance: inst.id,
            inference: 'centroid',
            origin: { id: aAlloc.take('r'), ref: { face } },
          };
        };
        const ca = connector(i1);
        const cb = connector(i2);
        if (!ca || !cb) return undefined;
        return {
          type: 'addMate',
          assemblyId: a.id,
          mate: {
            id: aAlloc.take('mate'),
            name: `${this.tag()}>${sigs.join(';')}`,
            kind: 'fastened',
            a: ca,
            b: cb,
            suppressed: false,
          },
        };
      }
      case 'configParameter': {
        if (part.features.length === 0) return undefined;
        const f = rng.pick(part.features);
        const id = new Alloc(doc.nextIds).take('cp');
        return {
          type: 'setConfigParameter',
          parameter: {
            id,
            name: `${this.tag()}>${namesSignature(part, [], [f.id])}`,
            kind: 'suppression',
            partId,
            featureId: f.id,
          },
        };
      }
      case 'configRow': {
        const params = doc.configurations?.parameters ?? [];
        if (params.length === 0) return undefined;
        const values: Record<string, boolean> = {};
        for (const p of params)
          if (p.kind === 'suppression' && rng.chance(0.5)) values[p.id] = true;
        return {
          type: 'setConfigRow',
          row: { id: new Alloc(doc.nextIds).take('cfg'), name: this.tag(), values },
        };
      }
      case 'camTool': {
        return {
          type: 'addCamTool',
          tool: {
            id: new Alloc(doc.cam.nextIds).take('tool'),
            name: this.tag(),
            kind: 'flat',
            number: 1 + rng.int(300),
            diameter: mm('6'),
            fluteLength: mm('19'),
            flutes: 2,
            presets: [],
          },
        } as Command;
      }
      case 'camSetup': {
        const zero = mm('0');
        return {
          type: 'addCamSetup',
          setup: {
            id: new Alloc(doc.cam.nextIds).take('setup'),
            name: this.tag(),
            part: partId,
            machine: 'shapeoko-5-pro-4x4',
            post: 'grbl',
            stock: {
              kind: 'fromBody',
              margins: { xMin: zero, xMax: zero, yMin: zero, yMax: zero, top: zero, bottom: zero },
            },
            wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
            heights: { clearance: mm('10'), retract: mm('5') },
            operations: [],
          },
        };
      }
      case 'camOperation': {
        if (doc.cam.setups.length === 0 || doc.cam.tools.length === 0) return undefined;
        const s = rng.pick(doc.cam.setups);
        const p = doc.parts.find((x) => x.id === s.part);
        if (!p) return undefined;
        const cAlloc = new Alloc(doc.cam.nextIds);
        const tool = rng.pick(doc.cam.tools).id;
        const sketches = p.features.filter(
          (f): f is SketchFeature =>
            f.kind === 'sketch' && f.entities.some((e) => e.kind === 'line'),
        );
        const ext = this.extrudes(p);
        let op: CamOperation;
        if (sketches.length > 0 && rng.chance(0.5)) {
          const sk = rng.pick(sketches);
          op = {
            id: cAlloc.take('pocket'),
            kind: 'pocket',
            name: `${this.tag()}>${namesSignature(p, [], [sk.id])}`,
            suppressed: false,
            tool,
            geometry: [
              {
                kind: 'region',
                sketch: sk.id as `sketch#${number}`,
                entities: [sk.entities[0]!.id],
              },
            ],
            depth: { kind: 'blind', depth: mm('2') },
            stepover: mm('0.45'),
            entry: { kind: 'plunge' },
            climb: true,
          } as CamOperation;
        } else if (ext.length > 0) {
          const face = `${rng.pick(ext).id}:cap:end`;
          op = {
            id: cAlloc.take('profile'),
            kind: 'profile',
            name: `${this.tag()}>${namesSignature(p, [face], [])}`,
            suppressed: false,
            tool,
            geometry: [{ kind: 'face', face: { id: cAlloc.take('r'), ref: { face } } }],
            feeds: { cut: mm('1000mm/min') },
            side: 'outside',
            depth: { kind: 'through' },
            entry: { kind: 'plunge' },
            leadIn: { kind: 'none' },
            leadOut: { kind: 'none' },
            climb: true,
          } as CamOperation;
        } else return undefined;
        return { type: 'addCamOperation', setupId: s.id, operation: op };
      }
    }
  }
}
