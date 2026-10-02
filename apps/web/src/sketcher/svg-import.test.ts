// @vitest-environment node
// SVG import into a sketch against the real solver (planegcs in Node) and region detection: the
// lettering fixture becomes regions with holes that pockets and V-carves can use, the solver
// leaves the imported geometry exactly where it was placed, and a few hundred imported entities
// solve fast. The timings are printed (`SVG-IMPORT ...`) for the task report.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_UNITS } from '@manufakture/core';
import { importSvg, svgImportCounts, type SvgImport } from '@manufakture/io';
import {
  OutlineBudget,
  SolverService,
  XY_PLANE,
  detectRegions,
  placeOutline,
  svgOutlineRegions,
} from '@manufakture/sketch';
import type {
  ArcEntity,
  OutlineEntity,
  PathCommand,
  SketchEntity,
  Vec2,
} from '@manufakture/sketch/model';
import { startTextPreviews } from './useTextPreviews';
import { afterAll, describe, expect, it } from 'vitest';
import { materialize } from './draft';
import { createSketchSession, keepSvgSources } from './session';
import { svgPreviewKey, svgPreviewOf, type SvgOutline } from './text';
import {
  DEFAULT_SVG_SETTINGS,
  MAX_IMPORT_ENTITIES,
  describeCounts,
  fitAndPlace,
  importProblem,
  readSvg,
  solverLoad,
  outlineProblem,
  svgArtwork,
  svgDraft,
  svgOutlineDraft,
  truncateUtf16,
  type SvgImportSettings,
} from './svg-import';

const LETTERS = readFileSync(
  join(import.meta.dirname, '../../../../packages/io/src/fixtures/svg/letters.svg'),
  'utf8',
);

type Fit = { ok: true; result: SvgImport; entities: number } | { ok: false; message: string };

/** Read once, then fit and place: the sketch-geometry import. */
function fit(text: string, settings: SvgImportSettings = DEFAULT_SVG_SETTINGS): Fit {
  const r = readSvg(text);
  if (!r.ok) return r;
  const f = fitAndPlace(r.value, settings);
  if (!f.ok) return f;
  const c = svgImportCounts(f.value);
  return { ok: true, result: f.value, entities: c.lines + c.arcs + c.circles };
}

/** Permanent ids, as the session would give them. */
function entitiesOf(text: string, settings = DEFAULT_SVG_SETTINGS): SketchEntity[] {
  const r = fit(text, settings);
  if (!r.ok) throw new Error(r.message);
  let n = 1;
  let k = 1;
  return materialize(
    svgDraft(r.result),
    () => `e${n++}`,
    () => `k${k++}`,
  ).entities;
}

const WORD = readFileSync(
  join(import.meta.dirname, '../../../../packages/io/src/fixtures/svg/word.svg'),
  'utf8',
);

/** A grid of `copies` of the lettering, by <use>, 130 by 60 mm apart. */
function grid(copies: number): string {
  const inner = LETTERS.replace(/^[\s\S]*?<g id="letters"[^>]*>/, '').replace(
    /<\/g>\s*<\/svg>\s*$/,
    '',
  );
  const uses = Array.from(
    { length: copies },
    (_, i) => `<use href="#letters" x="${(i % 4) * 130}" y="${Math.floor(i / 4) * 60}"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="520mm" height="${60 * Math.ceil(copies / 4)}mm" viewBox="0 0 520 ${60 * Math.ceil(copies / 4)}">
    <defs><g id="letters">${inner}</g></defs>${uses}</svg>`;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const service = new SolverService();
afterAll(() => service.close('sketch#svg'));

describe('svgDraft', () => {
  it('makes lines, counter-clockwise arcs and circles, with no constraints', () => {
    // Placed by the page corner: the file's own millimetres, y flipped.
    const r = fit(LETTERS, { ...DEFAULT_SVG_SETTINGS, anchor: 'page' });
    if (!r.ok) throw new Error(r.message);
    const draft = svgDraft(r.result);
    expect(draft.constraints).toEqual([]);
    const counts = svgImportCounts(r.result);
    expect(draft.entities).toHaveLength(counts.lines + counts.arcs + counts.circles);
    expect(r.entities).toBe(draft.entities.length);
    expect(draft.entities.every((e) => e.id.startsWith('$') && !e.construction)).toBe(true);
    // The B's bowls run clockwise in the file's loop: stored counter-clockwise, ends swapped.
    const arcs = draft.entities.filter((e): e is ArcEntity => e.kind === 'arc');
    for (const a of arcs) {
      const s = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
      const m = Math.atan2(a.end[1] - a.center[1], a.end[0] - a.center[0]);
      expect(Number.isFinite(s) && Number.isFinite(m)).toBe(true);
    }
    const bowl = arcs.find((a) => dist(a.center, [89, 35.5]) < 1e-9)!;
    // Upper bowl: from the bottom of the bowl (y 26) counter-clockwise to its top (y 45).
    expect(bowl.start[1]).toBeCloseTo(26, 9);
    expect(bowl.end[1]).toBeCloseTo(45, 9);
    expect(describeCounts(r.result)).toMatch(/^\d+ lines, \d+ arcs and 1 circle$/);
  });

  it('refuses files with nothing to import, broken XML, and too much geometry', () => {
    const empty = fit('<svg xmlns="http://www.w3.org/2000/svg"/>', DEFAULT_SVG_SETTINGS);
    expect(empty).toEqual({ ok: false, message: 'The file has no shapes to import.' });
    const broken = fit('<svg><g></svg>', DEFAULT_SVG_SETTINGS);
    expect(broken.ok).toBe(false);
    const huge = fit(grid(200), { ...DEFAULT_SVG_SETTINGS, tolerance: 0.0001 });
    expect(huge).toEqual({
      ok: false,
      message: expect.stringContaining(`more than ${MAX_IMPORT_ENTITIES.toLocaleString('en')}`),
    });
  });
});

describe('imported lettering in a sketch', () => {
  it('solves without moving anything, and gives the letters as regions with holes', async () => {
    const entities = entitiesOf(LETTERS);
    const r = await service.solve({ entities, constraints: [] });
    expect(r.status).toBe('solved');
    expect(r.diagnosis.conflicting).toEqual([]);
    // Kept in place: the solved coordinates are the imported ones, exactly.
    expect(r.entities).toEqual(entities);

    const { regions, voids, diagnostics } = detectRegions(r.entities);
    expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(regions.map((g) => g.holes.length).sort()).toEqual([0, 1, 1, 2]);
    expect(voids).toHaveLength(4);
    // Each letter's area: the outline's minus its counters', from io's contours.
    const imp = importSvg(LETTERS);
    const loopArea = (element: string) =>
      imp.contours
        .filter((c) => c.element === element)
        .map((c) => {
          let a = 0;
          for (const s of c.segments) {
            a += (s.start[0] * s.end[1] - s.end[0] * s.start[1]) / 2;
            if (s.kind === 'arc') {
              const rad = dist(s.start, s.center);
              const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
              const a1 = Math.atan2(s.end[1] - s.center[1], s.end[0] - s.center[0]);
              let t = (s.clockwise ? a0 - a1 : a1 - a0) % (2 * Math.PI);
              if (t < 0) t += 2 * Math.PI;
              a += ((s.clockwise ? -1 : 1) * rad * rad * (t - Math.sin(t))) / 2;
            }
          }
          return Math.abs(a);
        });
    const letter = (element: string) => {
      const [outer, ...holes] = loopArea(element);
      return outer! - holes.reduce((s, h) => s + h, 0);
    };
    const areas = regions.map((g) => g.area).sort((a, b) => a - b);
    const expected = [Math.PI * 16, letter('path#A'), letter('path#B'), letter('path#O')].sort(
      (a, b) => a - b,
    );
    areas.forEach((a, i) => expect(a).toBeCloseTo(expected[i]!, 6));
    // Pocket and V-carve sources: closed outer loops counter-clockwise, holes clockwise, every
    // curve a line, arc or circle with an edge id (what regionProfile hands the kernel).
    for (const g of regions) {
      expect(g.outer.curves.length).toBeGreaterThan(0);
      for (const c of [...g.outer.curves, ...g.holes.flatMap((h) => h.curves)]) {
        expect(['line', 'arc', 'circle']).toContain(c.kind);
        expect(c.edgeId).toMatch(/^e\d+/);
      }
    }
  });

  it('keeps the O within the tolerance of its Beziers as sketch arcs', () => {
    const entities = entitiesOf(LETTERS, {
      ...DEFAULT_SVG_SETTINGS,
      tolerance: 0.005,
      anchor: 'page',
    });
    // The O's outline (rx 14, ry 20 about (20, 25) in the file; y flipped): its four cubic quarters.
    const q: [Vec2, Vec2, Vec2, Vec2][] = [
      [
        [34, 25],
        [34, 13.954],
        [27.732, 5],
        [20, 5],
      ],
      [
        [20, 5],
        [12.268, 5],
        [6, 13.954],
        [6, 25],
      ],
      [
        [6, 25],
        [6, 36.046],
        [12.268, 45],
        [20, 45],
      ],
      [
        [20, 45],
        [27.732, 45],
        [34, 36.046],
        [34, 25],
      ],
    ];
    const curve: Vec2[] = [];
    for (const [p0, p1, p2, p3] of q) {
      for (let i = 0; i <= 2000; i++) {
        const t = i / 2000;
        const u = 1 - t;
        curve.push([
          u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
          u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
        ]);
      }
    }
    // The outline's arcs: every point of every one near the curve (a polyline of 8,000 chords).
    const outer = entities.filter(
      (e): e is ArcEntity => e.kind === 'arc' && e.center[0] < 37 && dist(e.start, [20, 25]) > 13.5,
    );
    expect(outer.length).toBeGreaterThan(8);
    let worst = 0;
    for (const a of outer) {
      const r = dist(a.start, a.center);
      const s = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
      let sweep = Math.atan2(a.end[1] - a.center[1], a.end[0] - a.center[0]) - s;
      if (sweep <= 0) sweep += 2 * Math.PI;
      for (let i = 0; i <= 40; i++) {
        const p: Vec2 = [
          a.center[0] + r * Math.cos(s + (sweep * i) / 40),
          a.center[1] + r * Math.sin(s + (sweep * i) / 40),
        ];
        let best = Infinity;
        for (let j = 0; j + 1 < curve.length; j++) {
          const [x0, y0] = curve[j]!;
          const [x1, y1] = curve[j + 1]!;
          const dx = x1 - x0;
          const dy = y1 - y0;
          if (dx === 0 && dy === 0) continue;
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / (dx * dx + dy * dy)),
          );
          best = Math.min(best, Math.hypot(p[0] - x0 - t * dx, p[1] - y0 - t * dy));
        }
        worst = Math.max(worst, best);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.005);
  });

  it('solves a few hundred imported entities fast (measured)', async () => {
    const measure = async (text: string, curves: 'arcs' | 'lines', session: string) => {
      const t0 = performance.now();
      const entities = entitiesOf(text, { ...DEFAULT_SVG_SETTINGS, curves });
      const tImport = performance.now() - t0;
      expect(
        importProblem({ entities: [], constraints: [] }, { entities, constraints: [] }, curves),
      ).toBeNull();

      const t1 = performance.now();
      const solved = await service.solve({ entities, constraints: [] });
      const tSolve = performance.now() - t1;
      expect(solved.status).toBe('solved');
      expect(solved.entities).toEqual(entities);

      // The interactive path: load the session, then an edit beside the artwork (incremental).
      const t2 = performance.now();
      expect((await service.update(session, { entities, constraints: [] })).status).toBe('solved');
      const tLoad = performance.now() - t2;
      const line: SketchEntity = {
        id: 'x1',
        kind: 'line',
        construction: false,
        start: [0, -20],
        end: [50, -20],
      };
      const t3 = performance.now();
      const edited = await service.update(session, {
        entities: [...entities, line],
        constraints: [{ id: 'k1', kind: 'horizontal', line: 'x1' }],
      });
      const tEdit = performance.now() - t3;
      expect(edited.status).toBe('solved');
      await service.close(session);

      const t4 = performance.now();
      const { regions, voids } = detectRegions(entities);
      const tRegions = performance.now() - t4;
      const arcs = entities.filter((e) => e.kind === 'arc').length;
      console.log(
        `SVG-IMPORT ${curves}: ${entities.length} entities (${arcs} arcs): import ${tImport.toFixed(1)} ms, ` +
          `regen solve ${tSolve.toFixed(1)} ms, session load ${tLoad.toFixed(1)} ms, edit ${tEdit.toFixed(1)} ms, ` +
          `regions ${tRegions.toFixed(1)} ms`,
      );
      // Loose bounds: a slow CI machine must not flake; typical numbers are far below.
      expect(tSolve).toBeLessThan(3000);
      expect(tEdit).toBeLessThan(3000);
      return { entities, regions, voids };
    };
    // Two copies with arcs (about 70 arcs), and eight copies as lines only (over a thousand lines).
    const arcs = await measure(grid(2), 'arcs', 'sketch#svg-arcs');
    expect(arcs.entities.length).toBeGreaterThan(100);
    expect(arcs.regions).toHaveLength(2 * 4);
    expect(arcs.voids).toHaveLength(2 * 4);
    const lines = await measure(grid(8), 'lines', 'sketch#svg-lines');
    expect(lines.entities.length).toBeGreaterThan(300);
    expect(lines.entities.filter((e) => e.kind === 'arc')).toHaveLength(0);
    expect(lines.regions).toHaveLength(8 * 4);
    expect(lines.voids).toHaveLength(8 * 4);
  }, 60_000);

  it('refuses an import the solver could not hold, which is why there is a guard', async () => {
    const entities = entitiesOf(grid(4));
    const arcs = entities.filter((e) => e.kind === 'arc').length;
    expect(arcs).toBeGreaterThan(120);
    const problem = importProblem(
      { entities: [], constraints: [] },
      { entities, constraints: [] },
      'arcs',
    );
    expect(problem).toMatch(new RegExp(`\\(${arcs} arcs\\), more than the sketch solver can hold`));
    expect(problem).toMatch(/import curves as lines/);
    // The published planegcs (16 MiB heap) runs out of memory on it. If this starts to solve,
    // the solver has grown (ADR 0003 decision 8) and MAX_SOLVER_LOAD can be raised.
    const r = await service.solve({ entities, constraints: [] });
    expect(r.status).toBe('aborted');
    // Free lines cost the solver nothing, but a sketch's own constraints and arcs count too.
    expect(
      solverLoad({
        entities: entitiesOf(grid(4), { ...DEFAULT_SVG_SETTINGS, curves: 'lines' }),
        constraints: [],
      }),
    ).toBe(0);
    const pinned = {
      entities: [
        {
          id: 'a',
          kind: 'arc' as const,
          construction: false,
          center: [0, 0] as Vec2,
          start: [1, 0] as Vec2,
          end: [0, 1] as Vec2,
        },
      ],
      constraints: [
        { id: 'k', kind: 'fix' as const, point: { entity: 'a', at: 'center' as const } },
      ],
    };
    expect(solverLoad(pinned)).toBe((4 + 2) * (6 + 9));
  });
});

describe('the session', () => {
  it('adds imported geometry as one undo step and selects it', async () => {
    const session = createSketchSession(service);
    session.getState().begin({
      featureId: 'sketch#svg2',
      isNew: true,
      name: 'Sketch 1',
      placement: XY_PLANE,
      entities: [],
      constraints: [],
      nextEntity: 5,
      nextConstraint: 1,
      units: DEFAULT_UNITS,
      variables: {},
    });
    await session.getState().idle();
    const r = fit(LETTERS, { ...DEFAULT_SVG_SETTINGS, anchor: 'center', at: [10, 10] });
    if (!r.ok) throw new Error(r.message);
    const ids = session.getState().importGeometry(svgDraft(r.result), 'Imported.');
    await session.getState().idle();
    const s = session.getState();
    expect(ids[0]).toBe('e5');
    expect(s.sketch.entities.map((e) => e.id)).toEqual(ids);
    expect(s.selection).toHaveLength(ids.length);
    expect(s.message).toBe('Imported.');
    expect(s.solve?.status).toBe('solved');
    expect(s.sketch.entities).toEqual(
      entitiesOf(LETTERS, { ...DEFAULT_SVG_SETTINGS, anchor: 'center', at: [10, 10] }).map(
        (e, i) => ({ ...e, id: `e${i + 5}` }),
      ),
    );
    s.undo();
    await session.getState().idle();
    expect(session.getState().sketch.entities).toEqual([]);
    session.getState().redo();
    expect(session.getState().sketch.entities).toHaveLength(ids.length);
    await session.getState().idle();
    session.getState().cancel();
  });
});

describe('imported as one outline', () => {
  const outlineOf = (text: string, at: Vec2 = [0, 0], scale: string | null = null) => {
    const parsed = readSvg(text);
    if (!parsed.ok) throw new Error(parsed.message);
    const art = svgArtwork(parsed.value);
    if (!art.ok) throw new Error(art.message);
    const draft = svgOutlineDraft(
      art.value,
      'letters.svg',
      'bottom-left',
      at,
      scale === null ? null : { source: scale, lengthUnit: 'mm', angleUnit: 'deg' },
    );
    expect(draft.entities).toHaveLength(1);
    return { ...(draft.entities[0] as OutlineEntity), id: 'e1' };
  };

  it('is one entity the solver sees as its anchor, with every shape kept exact', async () => {
    const e = outlineOf(LETTERS, [10, 20], '2');
    expect(e.anchor).toEqual([10, 20]);
    expect(e.source.kind === 'svg' && e.source.scale?.source).toBe('2');
    expect(e.source.kind === 'svg' && e.source.paths).toHaveLength(4);
    // Moved so the artwork's bottom left corner is the anchor: no coordinate below 0.
    const coords =
      e.source.kind === 'svg'
        ? e.source.paths.flatMap((p) => p.commands.flatMap((c) => (c.kind === 'close' ? [] : c.to)))
        : [];
    expect(Math.min(...coords)).toBeCloseTo(0, 6);
    const r = await service.solve({ entities: [e], constraints: [] });
    expect(r.status).toBe('solved');
    expect(r.diagnosis.dof).toBe(2);
    expect(r.entities).toEqual([e]);
    expect(solverLoad({ entities: [e], constraints: [] })).toBe(0);
  });

  it('gives the letters as regions with holes, at its scale', () => {
    const e = outlineOf(LETTERS);
    if (e.source.kind !== 'svg') throw new Error('not svg');
    const paths = e.source.paths;
    const at = (scale: number) => {
      const result = svgOutlineRegions(paths, scale);
      expect(result.issues.filter((i) => i.severity !== 'info')).toEqual([]);
      const shapes = placeOutline(
        e,
        paths.map((_, i) => i),
        result,
      );
      return detectRegions([e], { outlines: shapes });
    };
    const one = at(1);
    expect(one.regions.map((g) => g.holes.length).sort()).toEqual([0, 1, 1, 2]);
    const area = one.regions.reduce((a, g) => a + g.area, 0);
    // The same letters as sketch geometry, to within the arcs' tolerance.
    const fitted = detectRegions(entitiesOf(LETTERS)).regions.reduce((a, g) => a + g.area, 0);
    expect(Math.abs(area - fitted)).toBeLessThan(0.5);
    expect(at(2).regions.reduce((a, g) => a + g.area, 0)).toBeCloseTo(area * 4, 6);
  });

  it('holds a whole sign: 32 letters in one outline, measured', async () => {
    const t0 = performance.now();
    const e = outlineOf(grid(8));
    const tImport = performance.now() - t0;
    if (e.source.kind !== 'svg') throw new Error('not svg');
    const t1 = performance.now();
    const solved = await service.solve({ entities: [e], constraints: [] });
    const tSolve = performance.now() - t1;
    expect(solved.status).toBe('solved');
    const t2 = performance.now();
    const result = svgOutlineRegions(e.source.paths, 1);
    const tOutline = performance.now() - t2;
    const shapes = placeOutline(
      e,
      e.source.paths.map((_, i) => i),
      result,
    );
    const t3 = performance.now();
    const found = detectRegions([e], { outlines: shapes });
    const tRegions = performance.now() - t3;
    expect(found.regions).toHaveLength(8 * 4);
    console.log(
      `SVG-IMPORT outline: 8 copies (${e.source.paths.length} paths): import ${tImport.toFixed(1)} ms, ` +
        `solve ${tSolve.toFixed(1)} ms, outline regions ${tOutline.toFixed(1)} ms, regions ${tRegions.toFixed(1)} ms`,
    );
  });

  it('takes a whole word that sketch geometry could not hold', async () => {
    const parsed = readSvg(WORD);
    if (!parsed.ok) throw new Error(parsed.message);
    // As sketch lines and arcs: past what the solver holds.
    const fitted = fitAndPlace(parsed.value, DEFAULT_SVG_SETTINGS);
    if (!fitted.ok) throw new Error(fitted.message);
    const geometry = svgDraft(fitted.value);
    expect(importProblem({ entities: [], constraints: [] }, geometry, 'arcs')).toMatch(
      /more than the sketch solver can hold/,
    );
    // As one outline: eight letters, the counters of the three "O"s, the "D" and the "P" as holes.
    const e = outlineOf(WORD);
    if (e.source.kind !== 'svg') throw new Error('not svg');
    expect(e.source.paths).toHaveLength(8);
    expect((await service.solve({ entities: [e], constraints: [] })).status).toBe('solved');
    const result = svgOutlineRegions(e.source.paths, 1);
    expect(result.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const found = detectRegions([e], {
      outlines: placeOutline(
        e,
        e.source.paths.map((_, i) => i),
        result,
      ),
    });
    expect(found.regions).toHaveLength(8);
    expect(found.regions.reduce((n, g) => n + g.holes.length, 0)).toBe(5);
  });

  it('refuses artwork that reaches too far, has too many shapes, or would overfill the sketch', () => {
    const art = (body: string) => {
      const parsed = readSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
      if (!parsed.ok) throw new Error(parsed.message);
      return svgArtwork(parsed.value);
    };
    expect(art('<path d="M-1e308 0 L1e308 0 L0 1 Z"/>')).toEqual({
      ok: false,
      message: expect.stringMatching(/reaches past 1,000,000 mm/),
    });
    expect(art('<path d="M0 0 L3780000 0 L0 1 Z"/>').ok).toBe(false);
    expect(art('<path d="M0 0 L3700000 0 L0 1 Z"/>').ok).toBe(true);
    const many = art('<rect width="1" height="1"/>'.repeat(20_001));
    expect(many).toEqual({
      ok: false,
      message: expect.stringMatching(/more than the 20,000 shapes one outline holds/),
    });
    // Arcs reused under a huge scale: refused as soon as a cap is passed, not after.
    const arcs = `<defs><path id="p" d="M0 0 ${'a1 1 0 1 1 2 0 a1 1 0 1 1 -2 0 '.repeat(1000)}"/></defs>`;
    const t0 = performance.now();
    expect(art(`${arcs}<g transform="scale(1e12)">${'<use href="#p"/>'.repeat(10)}</g>`)).toEqual({
      ok: false,
      message: expect.stringMatching(/reaches past 1,000,000 mm/),
    });
    expect(art(`${arcs}<g transform="scale(1000)">${'<use href="#p"/>'.repeat(10)}</g>`)).toEqual({
      ok: false,
      message: expect.stringMatching(/more than the 100,000 path commands one outline holds/),
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    // The sketch's cap on SVG commands over all its outlines.
    const big = outlineOf(LETTERS);
    if (big.source.kind !== 'svg') throw new Error('not svg');
    const filler: PathCommand[] = Array.from({ length: 99_990 }, () => ({
      kind: 'lineTo',
      to: [0, 0],
    }));
    const full = {
      ...big,
      source: { ...big.source, paths: [{ fillRule: 'nonzero' as const, commands: filler }] },
    };
    expect(outlineProblem({ entities: [] }, { commands: 50 })).toBeNull();
    expect(outlineProblem({ entities: [full] }, { commands: 50 })).toMatch(
      /already has 99,990 path commands of SVG artwork/,
    );
  });

  it('cuts a long file name by UTF-16 units, never inside a surrogate pair', () => {
    expect(truncateUtf16('a'.repeat(300), 255)).toHaveLength(255);
    const emoji = 'a'.repeat(254) + '\u{1F600}';
    expect(emoji).toHaveLength(256);
    expect(truncateUtf16(emoji, 255)).toBe('a'.repeat(254));
    expect(truncateUtf16('short.svg', 255)).toBe('short.svg');
  });

  // 120 thin bars crossing at one point: one outline costs more than the whole preview budget.
  const bars = (dx: number): PathCommand[] =>
    Array.from({ length: 120 }, (_, i) => {
      const a = (Math.PI * i) / 120;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const w = 0.01;
      const p: Vec2[] = [
        [dx - 50 * c + w * s, -50 * s - w * c],
        [dx + 50 * c + w * s, 50 * s - w * c],
        [dx + 50 * c - w * s, 50 * s + w * c],
        [dx - 50 * c - w * s, -50 * s + w * c],
      ];
      return [
        { kind: 'moveTo', to: p[0]! },
        ...p.slice(1).map((to): PathCommand => ({ kind: 'lineTo', to })),
        { kind: 'close' },
      ] as PathCommand[];
    }).flat();
  const outline = (id: string, dx: number): OutlineEntity => ({
    id,
    kind: 'outline',
    construction: false,
    anchor: [0, 0],
    angle: 0,
    source: {
      kind: 'svg',
      fileName: 'x.svg',
      paths: [{ fillRule: 'nonzero', commands: bars(dx) }],
    },
  });

  it('shares one main-thread budget between the SVG previews of a pass', async () => {
    const session = createSketchSession(service);
    session.getState().begin({
      featureId: 'sketch#svg3',
      isNew: true,
      name: 'Sketch 1',
      placement: XY_PLANE,
      entities: [
        outline('e1', 0.001),
        outline('e2', 0.002),
        outline('e3', 0.003),
        outline('e4', 0.004),
      ],
      constraints: [],
      nextEntity: 5,
      nextConstraint: 1,
      units: DEFAULT_UNITS,
      variables: {},
    });
    const t0 = performance.now();
    const stop = startTextPreviews(session, null);
    const ms = performance.now() - t0;
    stop();
    console.log(`SVG-PREVIEW 4 costly outlines in one pass: ${ms.toFixed(0)} ms`);
    const texts = session.getState().texts;
    expect(Object.keys(texts).sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(
      Object.values(texts).filter((t) => /too complex to show here/.test(t.error ?? '')).length,
    ).toBeGreaterThan(0);
    // Bounded by the one budget, not four.
    expect(ms).toBeLessThan(15_000);
    await session.getState().idle();
    session.getState().cancel();
  }, 60_000);

  it("keeps the artwork's source across solves, so its preview is made once", async () => {
    const e = outlineOf(LETTERS);
    if (e.source.kind !== 'svg') throw new Error('not svg');
    const paths = e.source.paths;
    // Replies as a worker gives them: structured clones, never the objects sent.
    const cloning = new Proxy(service, {
      get(target, key) {
        const v: unknown = Reflect.get(target, key);
        return typeof v === 'function'
          ? async (...args: unknown[]) =>
              structuredClone(await (v as (...a: unknown[]) => unknown).apply(target, args))
          : v;
      },
    });
    const session = createSketchSession(cloning);
    session.getState().begin({
      featureId: 'sketch#svgkeep',
      isNew: true,
      name: 'Sketch 1',
      placement: XY_PLANE,
      entities: [e],
      constraints: [],
      nextEntity: 2,
      nextConstraint: 1,
      units: DEFAULT_UNITS,
      variables: {},
    });
    const stop = startTextPreviews(session, null, 0);
    const settle = async () => {
      await session.getState().idle();
      await new Promise((r) => setTimeout(r, 5));
    };
    await settle();
    const first = session.getState().texts.e1;
    expect(first?.layout).not.toBeNull();
    session.getState().updateText('e1', { angle: 0.5 });
    await settle();
    const after = session.getState().sketch.entities[0] as OutlineEntity;
    expect(after.angle).toBe(0.5);
    expect(after.source.kind === 'svg' && after.source.paths).toBe(paths);
    expect(session.getState().texts.e1).toBe(first);
    // A solve whose reply has other artwork (not what was sent) is taken as it is.
    const other = { ...e, source: { ...e.source, paths: structuredClone(paths).slice(1) } };
    expect(keepSvgSources([other], [e])[0]).toBe(other);
    stop();
    session.getState().cancel();
  });

  it("does not keep a preview refused for the pass's budget", () => {
    const e = outlineOf(LETTERS) as SvgOutline;
    // A budget earlier previews of the pass spent most of.
    const budget = new OutlineBudget(1000);
    budget.spend(900);
    const refused = svgPreviewOf(e, {}, budget);
    expect(refused.error).toMatch(/too complex to show here/);
    // Under a key no pass asks for: the next pass makes it again.
    expect(refused.key).not.toBe(svgPreviewKey(e, {}));
    const shown = svgPreviewOf(e, {});
    expect(shown.key).toBe(svgPreviewKey(e, {}));
    expect(shown.layout).not.toBeNull();
  });

  it('does not convert again an outline that alone spends a whole budget', async () => {
    const e = outline('e1', 0.001) as SvgOutline;
    // Refused for a budget it had to itself: kept under its own key.
    const alone = svgPreviewOf(e, {});
    expect(alone.error).toMatch(/too complex to show here/);
    expect(alone.key).toBe(svgPreviewKey(e, {}));
    // So a second pass of the sketcher leaves it as it is.
    const session = createSketchSession(service);
    session.getState().begin({
      featureId: 'sketch#svg-alone',
      isNew: true,
      name: 'Sketch 1',
      placement: XY_PLANE,
      entities: [outline('e1', 0.001)],
      constraints: [],
      nextEntity: 2,
      nextConstraint: 1,
      units: DEFAULT_UNITS,
      variables: {},
    });
    const stop = startTextPreviews(session, null, 0);
    const first = session.getState().texts.e1;
    expect(first?.error).toMatch(/too complex to show here/);
    session.getState().updateText('e1', { angle: 0.5 });
    await session.getState().idle();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 5));
    expect(performance.now() - t0).toBeLessThan(500);
    expect((session.getState().sketch.entities[0] as OutlineEntity).angle).toBe(0.5);
    expect(session.getState().texts.e1).toBe(first);
    stop();
    session.getState().cancel();
  }, 60_000);

  it('groups the warnings of 30,000 open subpaths into a few short ones', () => {
    const open: PathCommand[] = [];
    for (let i = 0; i < 30_000; i++) {
      const x = (i % 300) * 0.06;
      const y = Math.floor(i / 300) * 0.06;
      open.push({ kind: 'moveTo', to: [x, y] }, { kind: 'lineTo', to: [x + 0.03, y] });
    }
    const e: SvgOutline = {
      id: 'e1',
      kind: 'outline',
      construction: false,
      anchor: [0, 0],
      angle: 0,
      source: { kind: 'svg', fileName: 'x.svg', paths: [{ fillRule: 'nonzero', commands: open }] },
    };
    const preview = svgPreviewOf(e, {});
    expect(preview.error).toBeNull();
    expect(preview.warnings).toHaveLength(2);
    expect(preview.warnings.join('').length).toBeLessThan(1000);
    expect(preview.warnings[0]).toMatch(
      /^30,000 contours do not end where they start; .*shape 1 contour 0, .*, and 29,997 more\.$/,
    );
    expect(preview.warnings[1]).toMatch(/^30,000 contours enclose no area/);
  });
});
