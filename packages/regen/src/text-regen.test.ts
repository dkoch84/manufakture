// Text through regen with the real kernel and solver (T3.2c acceptance): a plate with a text in
// it, the plate cut around the letters and the letters extruded on their own; editing the string
// and the size variable; a reference to a glyph's side face; fonts that cannot be read.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  Command,
  DocumentFont,
  ExtrudeFeature,
  ManufaktureDocument,
  OutlineEntity,
  SketchFeature,
} from '@manufakture/core';
import type { KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  createSolverService,
  outlineRegionArea,
  outlineRegions,
  type SolverService,
} from '@manufakture/sketch';
import { INTER_BOLD, bundledFontUrl, layoutText, loadFont } from '@manufakture/text';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { expandOutlines } from './sketches';
import { TextCancelled, type TextOutliner, type TextReply } from './text';
import { createTextOutliner } from './text-engine';
import {
  PART,
  add,
  apply,
  build,
  extrude,
  fromDisk,
  mm,
  rectangle,
  setVariable,
  statuses,
} from './test-helpers';
import type { RegenResult } from './types';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

const interBytes = () => readFileSync(fileURLToPath(bundledFontUrl(INTER_BOLD.id)));
const inter = loadFont(new Uint8Array(interBytes()));

const BUNDLED: DocumentFont = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: { kind: 'bundled', id: INTER_BOLD.id, sha256: INTER_BOLD.sha256 },
};

function label(text: string, font = 'font#1'): OutlineEntity {
  return {
    id: 'e5',
    kind: 'outline',
    construction: false,
    anchor: [20, 15],
    angle: 0,
    source: {
      kind: 'text',
      text,
      font,
      size: mm('#size'),
      align: { horizontal: 'center', vertical: 'middle' },
    },
  };
}

/** The 40 x 30 rectangle of sketch#1 with a text in its middle. */
function plateSketch(text: string, font = 'font#1'): SketchFeature {
  const sketch = rectangle('sketch#1', { width: '40', depth: '30' });
  return { ...sketch, entities: [...sketch.entities, label(text, font)] };
}

function profiled(id: string, entities: string[], depth: string): ExtrudeFeature {
  return { ...extrude(id, 'sketch#1', depth), profile: { sketch: 'sketch#1', entities } };
}

/**
 * sketch#1 (the plate with a text), extrude#1 the plate (its four lines: letter-shaped holes, the
 * counters kept) 2 mm, extrude#2 the letters (the text) 1 mm, as two bodies.
 */
function labelled(text: string, extra: Command[] = []): ManufaktureDocument {
  return build([
    setVariable('size', '8'),
    { type: 'addFont', font: BUNDLED },
    ...extra,
    add(plateSketch(text, extra.length > 0 ? 'font#2' : 'font#1')),
    add(profiled('extrude#1', ['e1', 'e2', 'e3', 'e4'], '2')),
    add(profiled('extrude#2', ['e5'], '1')),
  ]);
}

/** The filled area of a text, computed glyph by glyph from the font (not through regen). */
function inkArea(text: string, size: number): number {
  const layout = layoutText(inter, text, { size, align: 'center', verticalAlign: 'middle' });
  return layout.glyphs
    .flatMap((g) => outlineRegions(g.path).regions)
    .reduce((a, r) => a + outlineRegionArea(r), 0);
}

function engine(): RegenEngine {
  return new RegenEngine({
    kernel: service,
    solver,
    text: createTextOutliner({ fetchImpl: fromDisk, allowFileFonts: true }),
  });
}

async function volume(e: RegenEngine, shape: ShapeId): Promise<number> {
  const reply = await service.run({ generation: e.generation, ops: [{ op: 'properties', shape }] });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

async function volumes(e: RegenEngine, result: RegenResult): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const b of result.parts[0]!.bodies) out[b.bodyId] = await volume(e, b.shape);
  return out;
}

const editText = (doc: ManufaktureDocument, text: string): Command => {
  const sketch = structuredClone(doc.parts[0]!.features[0] as SketchFeature);
  const source = (sketch.entities[4] as OutlineEntity).source;
  if (source.kind === 'text') source.text = text;
  return { type: 'editFeature', partId: PART, feature: sketch };
};

describe('text in a sketch, through regen and the kernel', () => {
  it('cuts the plate around the letters and extrudes the letters, from one sketch', async () => {
    const e = engine();
    const result = (await e.regen(labelled('OK')))!;
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'extrude#2': 'ok' });
    const sketch = result.parts[0]!.features[0]!;
    expect(sketch.warnings).toEqual([]);
    // Two letters ("O" with a counter, "K"), placed: what the sketcher draws.
    expect(sketch.outlines!.map((s) => [s.key, s.holes.map((h) => h.key)])).toEqual([
      ['e5.g0.c0', ['e5.g0.c1']],
      ['e5.g1.c0', []],
    ]);
    const ink = inkArea('OK', 8);
    const v = await volumes(e, result);
    // The plate keeps the inside of the "O": only the strokes are cut out of it.
    expect(v['extrude#1']).toBeCloseTo((1200 - ink) * 2, 3);
    expect(v['extrude#2']).toBeCloseTo(ink, 3);
  });

  it('extrudes merged glyphs: "Ø" (one region, two holes), "Ų" and "Ç" (one region each)', async () => {
    const e = engine();
    const result = (await e.regen(labelled('ØŲÇ')))!;
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'extrude#2': 'ok' });
    const shapes = result.parts[0]!.features[0]!.outlines!;
    expect(shapes.map((s) => [s.key, s.holes.length])).toEqual([
      ['e5.g0.c0', 2],
      ['e5.g1.c0', 0],
      ['e5.g2.c0', 0],
    ]);
    const v = await volumes(e, result);
    expect(v['extrude#2']).toBeCloseTo(inkArea('ØŲÇ', 8), 3);
    expect(v['extrude#1']).toBeCloseTo((1200 - inkArea('ØŲÇ', 8)) * 2, 3);
  });

  it('rebuilds when the string or the size variable changes', async () => {
    const e = engine();
    let doc = labelled('OK');
    await e.regen(doc);
    doc = apply(doc, editText(doc, 'O'));
    const shorter = (await e.regen(doc))!;
    expect((await volumes(e, shorter))['extrude#2']).toBeCloseTo(inkArea('O', 8), 3);
    doc = apply(doc, setVariable('size', '12'));
    const bigger = (await e.regen(doc))!;
    expect(bigger.parts[0]!.features[0]!.cached).toBe(false);
    const v = await volumes(e, bigger);
    expect(v['extrude#2']).toBeCloseTo(inkArea('O', 12), 3);
    expect(inkArea('O', 12)).toBeCloseTo(inkArea('O', 8) * (12 / 8) ** 2, 6);
    expect(v['extrude#1']).toBeCloseTo((1200 - inkArea('O', 12)) * 2, 3);
    // Unchanged again: the sketch comes from the cache.
    const again = (await e.regen(structuredClone(doc)))!;
    expect(again.parts[0]!.features[0]!.cached).toBe(true);
  });

  it('resolves a reference to a glyph side face with a fragile warning', async () => {
    const e = engine();
    const doc = labelled('K');
    const first = (await e.regen(doc))!;
    // A straight side of the "K": a planar face to sketch on.
    const edge = first.parts[0]!.features[0]!.outlines![0]!.outer.curves.find(
      (c) => c.kind === 'line',
    )!.edgeId;
    expect(edge).toMatch(/^e5\.g0\.c0\.s\d+#1$/);
    const onSide: SketchFeature = {
      id: 'sketch#2',
      kind: 'sketch',
      name: 'On a letter',
      suppressed: false,
      plane: { type: 'face', face: { id: 'r1', ref: { face: `extrude#2:side:${edge}` } } },
      entities: [{ id: 'e6', kind: 'point', construction: false, position: [0, 0] }],
      constraints: [],
    };
    const result = (await e.regen(apply(doc, add(onSide))))!;
    const sketch2 = result.parts[0]!.features[3]!;
    expect(sketch2.status).toBe('ok');
    expect(sketch2.references).toEqual([
      expect.objectContaining({ referenceId: 'r1', fragile: true }),
    ]);
    expect(sketch2.warnings).toEqual([
      expect.objectContaining({ code: 'reference', referenceId: 'r1', fragile: true }),
    ]);
  });

  it('warns about characters the font lacks, and fails a font that cannot be read', async () => {
    const e = engine();
    const missing = (await e.regen(labelled('⌀8')))!;
    expect(missing.parts[0]!.features[0]!.warnings).toEqual([
      expect.objectContaining({ code: 'text', entityId: 'e5', missing: ['⌀'] }),
    ]);

    const junk = Buffer.from('this is not a font');
    const userFont: DocumentFont = {
      id: 'font#2',
      family: 'Junk',
      style: 'Regular',
      source: {
        kind: 'file',
        fileName: 'junk.ttf',
        size: junk.length,
        sha256: createHash('sha256').update(junk).digest('hex'),
        data: junk.toString('base64'),
      },
    };
    const broken = (await e.regen(labelled('OK', [{ type: 'addFont', font: userFont }])))!;
    expect(statuses(broken)).toEqual({
      'sketch#1': 'error',
      'extrude#1': 'upstream-error',
      'extrude#2': 'upstream-error',
    });
    expect(broken.parts[0]!.features[0]!.errors).toEqual([
      {
        code: 'font',
        fontId: 'font#2',
        field: ['entities', 4, 'source', 'font'],
        message: expect.stringMatching(/^This font could not be read \(junk\.ttf\)/),
      },
    ]);
  });

  it('warns when the bundled font is not the file the text was made with, and misses the cache', async () => {
    const e = engine();
    const doc = labelled('OK');
    const first = (await e.regen(doc))!;
    const other = structuredClone(doc);
    other.fonts[0] = {
      ...BUNDLED,
      source: { kind: 'bundled', id: INTER_BOLD.id, sha256: '0'.repeat(64) },
    };
    const second = (await e.regen(other))!;
    const sketch = second.parts[0]!.features[0]!;
    expect(sketch.cached).toBe(false);
    expect(sketch.warnings).toEqual([
      expect.objectContaining({ code: 'font-changed', fontId: 'font#1' }),
    ]);
    // The geometry is the shipped font's, as before.
    expect((await volumes(e, second))['extrude#2']).toBeCloseTo(
      (await volumes(e, first))['extrude#2']!,
      9,
    );
  });
});

describe('text in regen: cancelling, budgets and limits', () => {
  /** An outliner that hangs on "HANG" until its call is aborted, and counts its calls. */
  function hangingOutliner(): TextOutliner & { calls: string[]; aborted: number } {
    const inner = createTextOutliner({ fetchImpl: fromDisk });
    const outliner = {
      calls: [] as string[],
      aborted: 0,
      async outline(...args: Parameters<TextOutliner['outline']>): Promise<TextReply> {
        const [request, call] = args;
        outliner.calls.push(request.text);
        if (request.text !== 'HANG') return inner.outline(request, call);
        return new Promise<TextReply>((_, reject) => {
          call?.signal?.addEventListener('abort', () => {
            outliner.aborted++;
            reject(new TextCancelled());
          });
        });
      },
    };
    return outliner;
  }

  it('aborts the text in flight when a newer regen supersedes it', async () => {
    const text = hangingOutliner();
    const e = new RegenEngine({ kernel: service, solver, text });
    const started = performance.now();
    const stale = e.regen(labelled('HANG'));
    // Let the first regen reach its text before the edit arrives.
    while (!text.calls.includes('HANG')) await new Promise((r) => setTimeout(r, 5));
    const fresh = e.regen(labelled('OK'));
    expect(await stale).toBeNull();
    const result = (await fresh)!;
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'extrude#2': 'ok' });
    expect(text.aborted).toBe(1);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(e.stats.superseded).toBe(1);
  });

  it('checks for a newer regen between the texts of a sketch', async () => {
    const font = BUNDLED;
    const sketch = plateSketch('A');
    const second = { ...label('B'), id: 'e6' };
    const feature: SketchFeature = { ...sketch, entities: [...sketch.entities, second] };
    const seen: string[] = [];
    let stale = false;
    const outliner: TextOutliner = {
      async outline(request) {
        seen.push(request.text);
        stale = true;
        return { ok: false, code: 'glyph', message: 'not needed' };
      },
    };
    await expect(
      expandOutlines(feature, feature.entities, {
        fonts: [font],
        values: new Map([
          ['entities.4.source.size', 8],
          ['entities.5.source.size', 8],
        ]),
        outliner,
        checkStale: () => {
          if (stale) throw new Error('superseded');
        },
      }),
    ).rejects.toThrow('superseded');
    expect(seen).toEqual(['A']);
  });

  it('does not cache a sketch whose text failed in a way that may not repeat', async () => {
    let fail = true;
    const inner = createTextOutliner({ fetchImpl: fromDisk });
    const text: TextOutliner = {
      outline: (request, call) =>
        fail
          ? Promise.resolve({
              ok: false,
              code: 'font',
              message:
                'This font could not be read (inter-bold): reading it took longer than 10 ms',
              transient: true,
            })
          : inner.outline(request, call),
    };
    const e = new RegenEngine({ kernel: service, solver, text });
    const doc = labelled('OK');
    const first = (await e.regen(doc))!;
    expect(statuses(first)['sketch#1']).toBe('error');
    fail = false;
    const second = (await e.regen(doc))!;
    expect(statuses(second)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'extrude#2': 'ok' });
    expect(second.parts[0]!.features[0]!.cached).toBe(false);
  });

  it("refuses a sketch whose texts place more curves than a sketch's texts may", async () => {
    const sketch = plateSketch('OK');
    const second = { ...label('KO'), id: 'e6' };
    const feature: SketchFeature = { ...sketch, entities: [...sketch.entities, second] };
    const out = await expandOutlines(feature, feature.entities, {
      fonts: [BUNDLED],
      values: new Map([
        ['entities.4.source.size', 8],
        ['entities.5.source.size', 8],
      ]),
      outliner: createTextOutliner({ fetchImpl: fromDisk }),
      // "OK" alone fits; "OK" and "KO" together do not.
      maxCurves: 40,
    });
    expect(out.shapes.map((s) => s.entityId)).toEqual(['e5', 'e5']);
    expect(out.errors).toEqual([
      {
        code: 'invalid',
        field: ['entities', 5, 'source', 'text'],
        message: expect.stringMatching(
          /^The texts of this sketch are too complex: with e6 they make \d+ curves, and a sketch's texts may make at most 40/,
        ),
      },
    ]);
  });
});
