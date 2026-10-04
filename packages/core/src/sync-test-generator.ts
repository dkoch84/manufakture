import { applyCommand, restoredDocument, type Command } from './commands';
import type {
  Assembly,
  CamOperation,
  ExtrudeFeature,
  Feature,
  ManufaktureDocument,
  MateConnector,
  Part,
  SketchFeature,
  StoredExpression,
} from './schema';

/**
 * Test-only: random command streams for the sync property tests, ported from the T7.0b spike's
 * generator (`spikes/T7.0b-sync/src/generator.ts`) and widened to every counter scope core has:
 * features of every M1 kind with edits, deletes, reorder, suppress, rollback, variables, batches,
 * restores and undos (the inverses core returns), parts, assemblies with instances, mates,
 * poses and exploded views, configurations, print setups, drawings with dimensions, and CAM.
 * Each command is tried with `applyCommand` and kept only if it applies, as a user can only make
 * commands that apply to what they see. Not exported from the package.
 */

/** mulberry32: small, fast, seeded. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const WEIGHTS = {
  sketch: 10,
  extrude: 10,
  fillet: 4,
  chamfer: 3,
  shell: 2,
  hole: 2,
  pattern: 3,
  mirror: 3,
  editExtrude: 4,
  editSketch: 5,
  delete: 3,
  reorder: 2,
  suppress: 2,
  rollback: 1,
  setVariable: 2,
  batch: 3,
  undo: 4,
  replaceDocument: 1,
  bodyProps: 1,
  addPart: 1,
  duplicatePart: 1,
  deletePart: 0.5,
  addAssembly: 1,
  addInstance: 2,
  editInstance: 1,
  setPoses: 1,
  addMate: 2,
  explodedView: 1,
  configParameter: 1.5,
  configRow: 1,
  activeConfiguration: 0.5,
  printSetup: 1,
  printItem: 1,
  drawing: 1,
  dimension: 1,
  camTool: 0.7,
  camSetup: 1,
  camOperation: 2,
};
export type Category = keyof typeof WEIGHTS;

export const mm = (source: string): StoredExpression => ({
  source,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});
const IDENTITY = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } as const;
const ZERO = mm('0');

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
  private coords = 0;
  /** Documents seen, for restores. */
  private readonly history: ManufaktureDocument[] = [];
  /** Inverses of generated commands, newest last, for undos. */
  private readonly inverses: Command[] = [];

  constructor(rng: Rng) {
    this.rng = rng;
  }

  private category(): Category {
    const entries = Object.entries(WEIGHTS) as [Category, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let x = this.rng.next() * total;
    for (const [c, w] of entries) {
      x -= w;
      if (x < 0) return c;
    }
    return entries[0]![0];
  }

  /** A command that applies to `doc`, or undefined if 40 tries found none. */
  generate(doc: ManufaktureDocument): Command | undefined {
    for (let attempt = 0; attempt < 40; attempt++) {
      const category = this.category();
      const command = this.make(category, doc);
      if (command === undefined) continue;
      const r = applyCommand(doc, command);
      if (!r.ok) continue;
      this.history.push(doc);
      if (category === 'undo') this.inverses.pop();
      else this.inverses.push(r.value.inverse);
      return command;
    }
    return undefined;
  }

  /** A command of `category` that applies to `doc`, or undefined. */
  force(category: Category, doc: ManufaktureDocument): Command | undefined {
    for (let attempt = 0; attempt < 10; attempt++) {
      const command = this.make(category, doc);
      if (command !== undefined && applyCommand(doc, command).ok) return command;
    }
    return undefined;
  }

  private uniq(): number {
    return ++this.coords * 50;
  }

  private part(doc: ManufaktureDocument): Part {
    const withFeatures = doc.parts.filter((p) => p.features.length > 0);
    return this.rng.chance(0.85) && withFeatures.length > 0
      ? this.rng.pick(withFeatures)
      : this.rng.pick(doc.parts);
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
    return [e, lines[i]!.id, lines[(i + 1) % lines.length]!.id];
  }

  /** A face name of `part` with a sub-id (and maybe a split or region suffix), or a cap. */
  private faceOf(part: Part): string | undefined {
    const edge = this.sideEdge(part);
    if (edge) return `${edge[0].id}:side:${edge[1]}${this.rng.pick(['', '', '#a', '#1'])}`;
    const ext = this.extrudes(part);
    return ext.length > 0 ? `${this.rng.pick(ext).id}:cap:end` : undefined;
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
        : { type: 'plane', origin: [0, 0, this.rng.int(50)], normal: [0, 0, 1], xDir: [1, 0, 0] };
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
    const pts: [number, number][] = [
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
      {
        id: alloc.take('k'),
        kind: 'coincident',
        a: { entity: entities[0]!.id, at: 'start' },
        b: { entity: '@origin' },
      },
    ];
    return { id, kind: 'sketch', name: id, suppressed: false, plane, entities, constraints };
  }

  private extrude(alloc: Alloc, sketch: SketchFeature): ExtrudeFeature {
    return {
      id: alloc.take('extrude'),
      kind: 'extrude',
      name: 'x',
      suppressed: false,
      profile: this.rng.chance(0.3)
        ? { sketch: sketch.id, entities: sketch.entities.map((e) => e.id) }
        : { sketch: sketch.id },
      operation: this.rng.pick(['new', 'new', 'add', 'cut'] as const),
      extent: this.rng.chance(0.3)
        ? { type: 'throughAll' }
        : { type: 'blind', distance: mm(this.rng.chance(0.5) ? 'thickness' : '5') },
      reverse: this.rng.chance(0.2),
    };
  }

  private assemblyWith(doc: ManufaktureDocument, n: number): Assembly | undefined {
    const as = doc.assemblies.filter((a) => a.instances.length >= n);
    return as.length === 0 ? undefined : this.rng.pick(as);
  }

  private instancePart(doc: ManufaktureDocument, a: Assembly, id: string): Part | undefined {
    const src = a.instances.find((i) => i.id === id)?.source;
    return src && 'part' in src ? doc.parts.find((p) => p.id === src.part) : undefined;
  }

  private make(category: Category, doc: ManufaktureDocument): Command | undefined {
    const rng = this.rng;
    const part = this.part(doc);
    const partId = part.id;
    const alloc = new Alloc(part.nextIds);
    const add = (feature: Feature): Command => ({ type: 'addFeature', partId, feature });
    switch (category) {
      case 'sketch':
        return add(this.sketch(part, alloc, rng.chance(0.25)));
      case 'extrude': {
        const sketches = part.features.filter(
          (f): f is SketchFeature =>
            f.kind === 'sketch' && f.entities.some((e) => e.kind === 'line'),
        );
        if (sketches.length === 0) return undefined;
        return add(this.extrude(alloc, rng.pick(sketches)));
      }
      case 'fillet':
      case 'chamfer': {
        const edge = this.sideEdge(part);
        if (!edge) return undefined;
        const [e, a, b] = edge;
        const faces = [`${e.id}:side:${a}`, `${e.id}:side:${b}`].sort();
        const edges = [
          {
            id: alloc.take('r'),
            ref: rng.chance(0.3) ? { faces, ends: [`${e.id}:cap:end`] } : { faces },
          },
        ];
        return add(
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
              },
        );
      }
      case 'shell': {
        const face = this.faceOf(part);
        if (!face) return undefined;
        return add({
          id: alloc.take('shell'),
          kind: 'shell',
          name: 'x',
          suppressed: false,
          faces: [{ id: alloc.take('r'), ref: { face } }],
          thickness: mm('1'),
          outward: false,
        });
      }
      case 'hole': {
        const sketches = part.features.filter(
          (f): f is SketchFeature =>
            f.kind === 'sketch' && f.entities.some((e) => e.kind === 'point'),
        );
        if (sketches.length === 0) return undefined;
        const s = rng.pick(sketches);
        const points = s.entities.filter((e) => e.kind === 'point').map((e) => e.id);
        return add({
          id: alloc.take('hole'),
          kind: 'hole',
          name: 'x',
          suppressed: false,
          sketch: s.id,
          points: points.slice(0, 1 + rng.int(points.length)),
          diameter: mm('3'),
          extent: { type: 'throughAll' },
          head: { type: 'simple' },
        });
      }
      case 'pattern':
      case 'mirror': {
        const edge = this.sideEdge(part);
        if (!edge) return undefined;
        const [e, a, b] = edge;
        if (category === 'pattern') {
          return add({
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
          });
        }
        return add({
          id: alloc.take('mirror'),
          kind: 'mirror',
          name: 'x',
          suppressed: false,
          features: [e.id],
          plane: { id: alloc.take('r'), ref: { face: `${e.id}:side:${a}` } },
        });
      }
      case 'editExtrude': {
        const ext = this.extrudes(part);
        if (ext.length === 0) return undefined;
        const e = rng.pick(ext);
        return {
          type: 'editFeature',
          partId,
          feature: { ...e, extent: { type: 'blind', distance: mm(String(1 + rng.int(20))) } },
        };
      }
      case 'editSketch': {
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
        return {
          type: 'editFeature',
          partId,
          feature: {
            ...s,
            entities: [...s.entities, line],
            constraints: [
              ...s.constraints,
              { id: alloc.take('k'), kind: 'horizontal', line: line.id },
            ],
          },
        };
      }
      case 'delete':
        if (part.features.length === 0) return undefined;
        return { type: 'deleteFeature', partId, featureId: rng.pick(part.features).id };
      case 'reorder':
        if (part.features.length < 2) return undefined;
        return {
          type: 'reorderFeature',
          partId,
          featureId: rng.pick(part.features).id,
          index: rng.int(part.features.length),
        };
      case 'suppress': {
        if (part.features.length === 0) return undefined;
        const f = rng.pick(part.features);
        return { type: 'suppressFeature', partId, featureId: f.id, suppressed: !f.suppressed };
      }
      case 'rollback':
        return {
          type: 'setRollback',
          partId,
          index: rng.chance(0.6) ? null : rng.int(part.features.length + 1),
        };
      case 'setVariable':
        return {
          type: 'setVariable',
          name: `v${rng.int(4)}`,
          expression: mm(String(1 + rng.int(9))),
        };
      case 'batch': {
        if (rng.chance(0.6)) {
          const s = this.sketch(part, alloc);
          return { type: 'batch', commands: [add(s), add(this.extrude(alloc, s))] };
        }
        const a = this.make(rng.pick(['setVariable', 'suppress', 'editExtrude'] as const), doc);
        const b = this.make('setVariable', doc);
        if (!a || !b) return undefined;
        return { type: 'batch', commands: [a, b] };
      }
      case 'undo':
        return this.inverses[this.inverses.length - 1];
      case 'replaceDocument': {
        if (this.history.length < 2) return undefined;
        const past = this.history[rng.int(this.history.length - 1)]!;
        return { type: 'replaceDocument', document: restoredDocument(doc, past) };
      }
      case 'bodyProps': {
        const ext = this.extrudes(part).filter((e) => e.operation === 'new');
        if (ext.length === 0) return undefined;
        return {
          type: 'setBodyProps',
          partId,
          bodyId: rng.pick(ext).id,
          props: { color: rng.pick(['#ff0000', '#00ff00']) },
        };
      }
      case 'addPart':
        return { type: 'addPart', partId: new Alloc(doc.nextIds).take('part'), name: 'p' };
      case 'duplicatePart':
        return {
          type: 'duplicatePart',
          sourcePartId: partId,
          partId: new Alloc(doc.nextIds).take('part'),
          name: 'copy',
        };
      case 'deletePart':
        if (doc.parts.length < 2) return undefined;
        return { type: 'deletePart', partId };
      case 'addAssembly':
        return {
          type: 'addAssembly',
          assemblyId: new Alloc(doc.nextIds).take('assembly'),
          name: 'a',
        };
      case 'addInstance': {
        if (doc.assemblies.length === 0) return undefined;
        const a = rng.pick(doc.assemblies);
        const target = this.part(doc);
        return {
          type: 'addInstance',
          assemblyId: a.id,
          instance: {
            id: new Alloc(a.nextIds).take('inst'),
            name: 'i',
            source: { part: target.id },
            fixed: a.instances.length === 0,
            suppressed: false,
            pose: IDENTITY,
          },
        };
      }
      case 'editInstance': {
        const a = this.assemblyWith(doc, 1);
        if (!a) return undefined;
        const inst = rng.pick(a.instances);
        const p = this.instancePart(doc, a, inst.id);
        const bodies = p ? this.extrudes(p).filter((e) => e.operation === 'new') : [];
        if (bodies.length === 0) return undefined;
        return {
          type: 'editInstance',
          assemblyId: a.id,
          instanceId: inst.id,
          bodies: [rng.pick(bodies).id],
        };
      }
      case 'setPoses': {
        const a = this.assemblyWith(doc, 1);
        if (!a) return undefined;
        const inst = rng.pick(a.instances);
        return {
          type: 'setPoses',
          assemblyId: a.id,
          poses: { [inst.id]: { translation: [rng.int(9), 0, 0], rotation: [0, 0, 0, 1] } },
        };
      }
      case 'addMate': {
        const a = this.assemblyWith(doc, 2);
        if (!a) return undefined;
        const aAlloc = new Alloc(a.nextIds);
        const [i1, i2] = [a.instances[0]!, a.instances[1 + rng.int(a.instances.length - 1)]!];
        const connector = (instId: string): MateConnector | undefined => {
          const p = this.instancePart(doc, a, instId);
          const face = p && this.faceOf(p);
          if (!face) return undefined;
          return {
            id: aAlloc.take('mc'),
            instance: instId,
            inference: 'centroid',
            origin: { id: aAlloc.take('r'), ref: { face } },
          };
        };
        const ca = connector(i1.id);
        const cb = connector(i2.id);
        if (!ca || !cb) return undefined;
        return {
          type: 'addMate',
          assemblyId: a.id,
          mate: {
            id: aAlloc.take('mate'),
            name: 'm',
            kind: 'fastened',
            a: ca,
            b: cb,
            suppressed: false,
          },
        };
      }
      case 'explodedView': {
        const a = this.assemblyWith(doc, 1);
        if (!a) return undefined;
        const aAlloc = new Alloc(a.nextIds);
        const inst = rng.pick(a.instances);
        const p = this.instancePart(doc, a, inst.id);
        const face = p && this.faceOf(p);
        if (!face) return undefined;
        return {
          type: 'addExplodedView',
          assemblyId: a.id,
          explodedView: {
            id: aAlloc.take('explode'),
            name: 'x',
            steps: [
              {
                id: aAlloc.take('step'),
                instances: [inst.id],
                direction: { instance: inst.id, face: { face } },
                distance: mm('10'),
              },
            ],
          },
        };
      }
      case 'configParameter': {
        if (part.features.length === 0) return undefined;
        return {
          type: 'setConfigParameter',
          parameter: {
            id: new Alloc(doc.nextIds).take('cp'),
            name: 'c',
            kind: 'suppression',
            partId,
            featureId: rng.pick(part.features).id,
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
          row: { id: new Alloc(doc.nextIds).take('cfg'), name: 'r', values },
        };
      }
      case 'activeConfiguration': {
        const rows = doc.configurations?.rows ?? [];
        if (rows.length === 0) return undefined;
        return {
          type: 'setActiveConfiguration',
          rowId: rng.chance(0.3) ? null : rng.pick(rows).id,
        };
      }
      case 'printSetup': {
        const pAlloc = new Alloc(doc.print.nextIds);
        const face = this.faceOf(part);
        return {
          type: 'addPrintSetup',
          setup: {
            id: pAlloc.take('print'),
            name: 'p',
            printer: 'bambu-a1-mini',
            nozzle: 0.4,
            items: face
              ? [
                  {
                    id: pAlloc.take('item'),
                    part: partId,
                    orientation: { kind: 'layFlat', face: { id: pAlloc.take('r'), ref: { face } } },
                  },
                ]
              : [],
          },
        };
      }
      case 'printItem': {
        if (doc.print.setups.length === 0) return undefined;
        const ext = this.extrudes(part).filter((e) => e.operation === 'new');
        if (ext.length === 0) return undefined;
        return {
          type: 'addPrintItem',
          setupId: rng.pick(doc.print.setups).id,
          item: {
            id: new Alloc(doc.print.nextIds).take('item'),
            part: partId,
            body: rng.pick(ext).id,
            orientation: { kind: 'asModelled' },
          },
        };
      }
      case 'drawing': {
        const dAlloc = new Alloc({});
        const bodies = this.extrudes(part).filter((e) => e.operation === 'new');
        const view = {
          id: dAlloc.take('view'),
          source:
            bodies.length > 0 && rng.chance(0.5)
              ? { part: partId, bodies: [rng.pick(bodies).id] }
              : { part: partId },
          direction: 'front' as const,
          scale: { paper: mm('1'), model: mm('1') },
          position: [100, 100] as const,
          options: { hidden: false, smooth: false },
        };
        return {
          type: 'addDrawing',
          drawing: {
            id: new Alloc(doc.nextIds).take('drawing'),
            name: 'd',
            sheets: [
              {
                id: dAlloc.take('sheet'),
                name: 's',
                size: 'A4',
                orientation: 'landscape',
                views: [view],
                dimensions: [],
                notes: [{ id: dAlloc.take('note'), view: view.id, position: [0, 0], text: 'n' }],
              },
            ],
            nextIds: { view: 2, sheet: 2, note: 2 },
          },
        };
      }
      case 'dimension': {
        const drawings = doc.drawings ?? [];
        if (drawings.length === 0) return undefined;
        const d = rng.pick(drawings);
        const sheet = d.sheets[0];
        const view = sheet?.views.find((v) => 'part' in v.source && !('domain' in v.source));
        if (!sheet || !view || !('part' in view.source)) return undefined;
        const p = doc.parts.find((x) => x.id === (view.source as { part: string }).part);
        const ext = p ? this.extrudes(p) : [];
        if (!p || ext.length === 0) return undefined;
        const e = rng.pick(ext);
        const face = this.faceOf(p) ?? `${e.id}:cap:end`;
        return {
          type: 'addDimension',
          drawingId: d.id,
          sheetId: sheet.id,
          dimension: {
            id: new Alloc(d.nextIds).take('dim'),
            view: view.id,
            kind: 'horizontal',
            refs: [
              { face: { face: `${e.id}:cap:start` }, body: e.id },
              { edge: { faces: [face, `${e.id}:cap:end`].sort() }, body: e.id },
            ],
            offset: 10,
          },
        };
      }
      case 'camTool':
        return {
          type: 'addCamTool',
          tool: {
            id: new Alloc(doc.cam.nextIds).take('tool'),
            name: 't',
            kind: 'flat',
            diameter: mm('6'),
            fluteLength: mm('19'),
            flutes: 2,
            presets: [],
          },
        };
      case 'camSetup': {
        const cAlloc = new Alloc(doc.cam.nextIds);
        const face = this.faceOf(part);
        return {
          type: 'addCamSetup',
          setup: {
            id: cAlloc.take('setup'),
            name: 's',
            part: partId,
            machine: 'shapeoko-5-pro-4x4',
            post: 'grbl',
            stock: {
              kind: 'fromBody',
              margins: { xMin: ZERO, xMax: ZERO, yMin: ZERO, yMax: ZERO, top: ZERO, bottom: ZERO },
            },
            wcs: {
              up:
                face && rng.chance(0.5)
                  ? { kind: 'face', face: { id: cAlloc.take('r'), ref: { face } } }
                  : { kind: 'axis', axis: '+z' },
              origin: { xy: 'front-left', z: 'top' },
            },
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
        const face = this.faceOf(p);
        const holes = p.features.filter((f) => f.kind === 'hole').map((f) => f.id);
        let op: CamOperation;
        if (sketches.length > 0 && rng.chance(0.5)) {
          const sk = rng.pick(sketches);
          op = {
            id: cAlloc.take('pocket'),
            kind: 'pocket',
            name: 'o',
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
            entry: { kind: 'plunge' },
            climb: true,
          };
        } else if (holes.length > 0 && rng.chance(0.5)) {
          op = {
            id: cAlloc.take('drill'),
            kind: 'drill',
            name: 'o',
            suppressed: false,
            tool,
            geometry: [{ kind: 'hole', feature: rng.pick(holes) as `hole#${number}` }],
          };
        } else if (face) {
          op = {
            id: cAlloc.take('profile'),
            kind: 'profile',
            name: 'o',
            suppressed: false,
            tool,
            geometry: [{ kind: 'face', face: { id: cAlloc.take('r'), ref: { face } } }],
            side: 'outside',
            depth: { kind: 'through' },
            entry: { kind: 'plunge' },
            leadIn: { kind: 'none' },
            leadOut: { kind: 'none' },
            climb: true,
          };
        } else return undefined;
        return { type: 'addCamOperation', setupId: s.id, operation: op };
      }
    }
  }
}
