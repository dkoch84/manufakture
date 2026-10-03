import { describe, expect, it } from 'vitest';
import { assembleJob, type JobOperation } from '../job';
import type { IrEntry, Toolpath } from '../ir';
import { generatePocket, type PocketOperation } from '../ops/pocket';
import { generateProfile, type ProfileOperation } from '../ops/profile';
import { movesWithStarts, sampleMove } from '../test-helpers';
import type { Box3, Setup, Tool, Vec3 } from '../types';
import type { OperationContext } from '../worker/registry';
import {
  profileHeight,
  simCellSize,
  sweepMove,
  toolProfile,
  SIM_MAX_CELLS,
  type SimGrid,
} from './heightfield';
import { meshToMachine, rasterPart } from './part';
import {
  MaterialSimulation,
  SIM_CLASS,
  SIM_DEFLECTION,
  SIM_TOLERANCE,
  type SimulationProgram,
} from './simulation';
import { BRACKET, bracketMesh, bracketOutline, plateWithHole, type PocketBox } from './test-parts';

const flat6: Tool = {
  id: 'tool#1',
  name: '6 mm flat',
  kind: 'flat',
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const ball6: Tool = {
  id: 'tool#2',
  name: '6 mm ball',
  kind: 'ball',
  diameter: 6,
  fluteLength: 25,
  flutes: 2,
};
const bull6: Tool = {
  id: 'tool#3',
  name: '6 mm bull',
  kind: 'bull',
  diameter: 6,
  cornerRadius: 1,
  fluteLength: 25,
  flutes: 2,
};
const vbit90: Tool = {
  id: 'tool#4',
  name: '90 degree V',
  kind: 'vbit',
  diameter: 12,
  angle: Math.PI / 2,
  fluteLength: 8,
  flutes: 2,
};
const feeds = { spindle: 18000, cut: 1000, plunge: 300, ramp: 500, lead: 800 };

const stock: Box3 = { min: [0, 0, -10], max: [60, 40, 0] };

const tc = (tool: Tool): IrEntry => ({ kind: 'toolChange', tool: tool.id, name: tool.name });
const rapid = (to: Vec3): IrEntry => ({ kind: 'rapid', to, op: 't', pass: 0 });
const line = (to: Vec3): IrEntry => ({
  kind: 'linear',
  to,
  feed: 1000,
  feedClass: 'cut',
  op: 't',
  pass: 0,
});

function simulate(program: SimulationProgram, cell = 0.1): MaterialSimulation {
  const r = MaterialSimulation.create(program, { cell });
  if (!r.ok) throw new Error(r.error.message);
  r.value.runTo(Infinity);
  return r.value;
}

/** A straight cut along y = 20 from x = 10 to 50 at `z` with `tool`. */
function slot(tool: Tool, z: number, cell = 0.1): MaterialSimulation {
  return simulate(
    {
      toolpath: {
        start: [10, 20, 5],
        entries: [
          tc(tool),
          rapid([10, 20, 1]),
          line([10, 20, z]),
          line([50, 20, z]),
          rapid([50, 20, 5]),
        ],
      },
      tools: [tool],
      stock,
    },
    cell,
  );
}

/** Heights across the slot at x = 30: [offset from the slot's centre line, height]. */
function section(sim: MaterialSimulation): [number, number][] {
  const out: [number, number][] = [];
  const g = sim.grid;
  const i = Math.floor((30 - g.x0) / g.cell);
  for (let j = 0; j < g.ny; j++) {
    out.push([g.y0 + (j + 0.5) * g.cell - 20, sim.heights[j * g.nx + i]!]);
  }
  return out;
}

describe('tool profiles', () => {
  it('describes each kind of tool', () => {
    const p = (t: Tool) => {
      const r = toolProfile(t);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    expect(profileHeight(p(flat6), 2.9)).toBe(0);
    expect(profileHeight(p(ball6), 3)).toBeCloseTo(3, 12);
    expect(profileHeight(p(ball6), 0)).toBe(0);
    expect(profileHeight(p(bull6), 2)).toBe(0);
    expect(profileHeight(p(bull6), 3)).toBeCloseTo(1, 12);
    expect(profileHeight(p(vbit90), 4)).toBeCloseTo(4, 12);
    const drill = p({ ...flat6, kind: 'drill' });
    expect(drill.kind).toBe('vbit');
    expect(toolProfile({ ...flat6, diameter: 0 }).ok).toBe(false);
    expect(toolProfile({ ...bull6, cornerRadius: 4 }).ok).toBe(false);
  });

  it('takes the cell from the smallest tool and caps it for memory', () => {
    expect(simCellSize(stock, [flat6, { diameter: 3.2 }])).toBeCloseTo(0.2, 12);
    const big: Box3 = { min: [0, 0, 0], max: [2000, 2000, 1] };
    const cell = simCellSize(big, [{ diameter: 0.5 }]);
    expect(Math.ceil(2000 / cell) ** 2).toBeLessThanOrEqual(SIM_MAX_CELLS);
    expect(cell).toBeLessThan(1.01);
  });

  it('sizes the cell of a V-bit by the width it cuts, not its shank', () => {
    // 12 mm across, sharp: the nominal 1 mm cut width.
    expect(simCellSize(stock, [vbit90])).toBeCloseTo(1 / 16, 12);
    // A wide flat tip is what it cuts.
    expect(simCellSize(stock, [{ ...vbit90, tipDiameter: 3.2 }])).toBeCloseTo(0.2, 12);
    // An engraver narrower than the nominal width: its diameter.
    expect(simCellSize(stock, [{ ...vbit90, kind: 'engraver', diameter: 0.8 }])).toBeCloseTo(
      0.05,
      12,
    );
    // Still capped for memory.
    const big: Box3 = { min: [0, 0, 0], max: [2000, 2000, 1] };
    expect(Math.ceil(2000 / simCellSize(big, [vbit90])) ** 2).toBeLessThanOrEqual(SIM_MAX_CELLS);
  });
});

describe('material removal', () => {
  it("a single straight cut leaves a slot of the tool's width and depth", () => {
    const sim = slot(flat6, -2);
    const cut = section(sim).filter(([, h]) => h < -1);
    // Every cell across it is at the cut depth, the rest untouched.
    expect(cut.every(([, h]) => h === -2)).toBe(true);
    expect(
      section(sim)
        .filter(([, h]) => h >= -1)
        .every(([, h]) => h === 0),
    ).toBe(true);
    const width = cut.length * sim.grid.cell;
    expect(Math.abs(width - 6)).toBeLessThanOrEqual(sim.grid.cell + 1e-9);
    expect(Math.max(...cut.map(([dy]) => Math.abs(dy)))).toBeLessThanOrEqual(3);
    // It runs from x = 10 - 3 to 50 + 3: rounded ends.
    expect(sim.heightAt(7.2, 20)).toBe(-2);
    expect(sim.heightAt(6.8, 20)).toBe(0);
    expect(sim.heightAt(52.8, 20)).toBe(-2);
    expect(sim.heightAt(8, 22.5)).toBe(0); // outside the end's round
    expect(sim.collisions()).toEqual([]);
  });

  it('a ball tool leaves a round-bottomed groove of its radius', () => {
    const sim = slot(ball6, -3);
    const cut = section(sim).filter(([, h]) => h < 0);
    expect(cut.length).toBeGreaterThan(50);
    for (const [dy, h] of cut) {
      // On the circle of radius 3 about (dy, z) = (0, 0): exact at cell centres.
      expect(h).toBeCloseTo(-Math.sqrt(9 - dy * dy), 5);
    }
    // Fit the circle through three points of the section and recover centre and radius.
    const pick = (t: number) =>
      cut.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a));
    const [[x1, y1], [x2, y2], [x3, y3]] = [pick(-2.5), pick(0), pick(2.2)];
    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    const ux =
      ((x1 ** 2 + y1 ** 2) * (y2 - y3) +
        (x2 ** 2 + y2 ** 2) * (y3 - y1) +
        (x3 ** 2 + y3 ** 2) * (y1 - y2)) /
      d;
    const uy =
      ((x1 ** 2 + y1 ** 2) * (x3 - x2) +
        (x2 ** 2 + y2 ** 2) * (x1 - x3) +
        (x3 ** 2 + y3 ** 2) * (x2 - x1)) /
      d;
    expect(Math.hypot(x1 - ux, y1 - uy)).toBeCloseTo(3, 4);
    expect(uy).toBeCloseTo(0, 4);
    expect(Math.min(...cut.map(([, h]) => h))).toBeCloseTo(-3, 2);
  });

  it('bull and V tools leave their own sections', () => {
    for (const [dy, h] of section(slot(bull6, -2)).filter(([, v]) => v < 0)) {
      const r = Math.abs(dy);
      const expected = r <= 2 ? -2 : -2 + 1 - Math.sqrt(Math.max(0, 1 - (r - 2) ** 2));
      expect(h).toBeCloseTo(expected, 5);
    }
    // 90 degrees: a V as wide at the top as twice its depth.
    const v = slot(vbit90, -2);
    const cut = section(v).filter(([, h]) => h < 0);
    for (const [dy, h] of cut) expect(h).toBeCloseTo(-2 + Math.abs(dy), 5);
    expect(Math.abs(cut.length * v.grid.cell - 4)).toBeLessThanOrEqual(v.grid.cell + 1e-9);
  });

  it('cuts along arcs and helices', () => {
    // A full circle of radius 10 about (30, 20) at -1, after a helical turn down from 0.
    const sim = simulate({
      toolpath: {
        start: [40, 20, 5],
        entries: [
          tc(flat6),
          rapid([40, 20, 0.5]),
          {
            kind: 'arc',
            to: [40, 20, -1],
            center: [30, 20],
            direction: 'ccw',
            fullCircle: true,
            feed: 500,
            feedClass: 'ramp',
            op: 't',
            pass: 0,
          },
          {
            kind: 'arc',
            to: [40, 20, -1],
            center: [30, 20],
            direction: 'ccw',
            fullCircle: true,
            feed: 500,
            feedClass: 'cut',
            op: 't',
            pass: 0,
          },
          // In to radius 5, then a half turn clockwise through the bottom, (35, 20) to (25, 20).
          line([35, 20, -1]),
          {
            kind: 'arc',
            to: [25, 20, -1],
            center: [30, 20],
            direction: 'cw',
            fullCircle: false,
            feed: 500,
            feedClass: 'cut',
            op: 't',
            pass: 0,
          },
          rapid([25, 20, 5]),
        ],
      },
      tools: [flat6],
      stock,
    });
    // The ring 7 to 13 from the centre is cut, and outside 13 is not.
    for (let a = 0; a < 2 * Math.PI; a += 0.3) {
      const at = (r: number) => sim.heightAt(30 + r * Math.cos(a), 20 + r * Math.sin(a));
      expect(at(10)).toBe(-1);
      expect(at(7.2)).toBe(-1);
      expect(at(13.5)).toBe(0);
    }
    // The half turn of radius 5 sweeps radii 2 to 8 below the centre only.
    expect(sim.heightAt(30, 17)).toBe(-1);
    expect(sim.heightAt(30, 22.5)).toBe(0);
    expect(sim.heightAt(30.1, 20.1)).toBe(0);
    expect(sim.collisions()).toEqual([]);
  });

  it('plays incrementally, forwards and back, as it would from scratch', () => {
    const program: SimulationProgram = {
      toolpath: {
        start: [10, 10, 5],
        entries: [
          tc(flat6),
          rapid([10, 10, 1]),
          line([10, 10, -1]),
          line([50, 10, -1]),
          line([50, 30, -2]),
          line([10, 30, -1]),
          rapid([10, 30, 5]),
        ],
      },
      tools: [flat6],
      stock,
    };
    const fresh = (n: number) => {
      const r = MaterialSimulation.create(program, { cell: 0.25 });
      if (!r.ok) throw new Error(r.error.message);
      r.value.runTo(n);
      return r.value.heights;
    };
    const r = MaterialSimulation.create(program, { cell: 0.25, snapshotBytes: 2 * 160 * 100 * 4 });
    if (!r.ok) throw new Error(r.error.message);
    const sim = r.value;
    for (const n of [2, 6, 3, 1, 4, 0, 6]) {
      sim.runTo(n);
      expect(sim.done).toBe(n);
      expect(sim.heights).toEqual(fresh(n));
    }
  });
});

describe('moves that change Z', () => {
  it('stamps a steep ramp closely enough in Z that its sides are not left high', () => {
    // A 6 mm flat ramping 6 mm down over 1 mm along X: 80 degrees.
    const g: SimGrid = { x0: 0, y0: 0, cell: 0.1, nx: 200, ny: 200 };
    const p = toolProfile(flat6);
    if (!p.ok) throw new Error(p.error.message);
    const from: Vec3 = [10, 10, 0];
    const to: Vec3 = [11, 10, -6];
    const low = new Float64Array(g.nx * g.ny).fill(Infinity);
    sweepMove(
      g,
      from,
      { kind: 'linear', to, feed: 500, feedClass: 'ramp', op: 't', pass: 0 },
      p.value,
      3,
      0.025,
      (k, z) => {
        if (z < low[k]!) low[k] = z;
      },
    );
    // Exact: a cell centre's lowest is where the tool is last over it, the largest t with the
    // centre within 3 mm of the tool's axis.
    let worst = 0;
    let checked = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const x = (i + 0.5) * g.cell - from[0];
        const y = (j + 0.5) * g.cell - from[1];
        // |(x - t, y)| <= 3: t in [x - w, x + w], w = sqrt(9 - y^2), clipped to [0, 1].
        const q = 9 - y * y;
        if (q < 0) continue;
        const t = Math.min(1, x + Math.sqrt(q));
        if (t < 0 || x - Math.sqrt(q) > 1) continue;
        const exact = from[2] + (to[2] - from[2]) * t;
        const k = j * g.nx + i;
        expect(low[k]!).toBeGreaterThanOrEqual(exact - 1e-9); // never deeper than the move
        worst = Math.max(worst, low[k]! - exact);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
    // Before, stamps half a cell apart in XY were 0.3 mm apart in Z here.
    expect(worst).toBeLessThanOrEqual(0.025 + 1e-9);
  });

  it('stamps a plunge straight down once at each end', () => {
    const g: SimGrid = { x0: 0, y0: 0, cell: 0.5, nx: 40, ny: 40 };
    const p = toolProfile(flat6);
    if (!p.ok) throw new Error(p.error.message);
    let visits = 0;
    sweepMove(
      g,
      [10, 10, 0],
      { kind: 'linear', to: [10, 10, -6], feed: 300, feedClass: 'plunge', op: 't', pass: 0 },
      p.value,
      3,
      0.025,
      () => void visits++,
    );
    let disc = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        if (Math.hypot((i + 0.5) * 0.5 - 10, (j + 0.5) * 0.5 - 10) <= 3) disc++;
      }
    }
    expect(visits).toBe(2 * disc);
  });
});

describe('rapids', () => {
  it('reports a rapid through uncut stock, not one inside a cut', () => {
    const sim = simulate(
      {
        toolpath: {
          start: [10, 20, 5],
          entries: [
            tc(flat6),
            rapid([10, 20, 0.5]),
            line([10, 20, -2]),
            line([50, 20, -2]),
            // Inside the slot just cut: fine.
            rapid([30, 20, -1.5]),
            rapid([30, 20, 5]),
            // Straight down into the stock, then across it below its top.
            rapid([10, 5, -1]),
            rapid([50, 5, -1]),
          ],
        },
        tools: [flat6],
        stock,
      },
      0.25,
    );
    const found = sim.collisions();
    expect(found.map((c) => c.move)).toEqual([5, 6]);
    expect(found[0]!.depth).toBeCloseTo(1, 9);
    // The second runs through the uncut stock top, 1 mm above its tip.
    expect(found[1]!.depth).toBeCloseTo(1, 9);
    expect(found[1]!.at[2]).toBe(0);
    // Going back drops the collisions not yet reached.
    sim.runTo(5);
    expect(sim.collisions()).toHaveLength(0);
    sim.runTo(6);
    expect(sim.collisions().map((c) => c.move)).toEqual([5]);
  });

  it('checks the rapids of a tool of 0.1 mm or less too', () => {
    const fine: Tool = { ...flat6, id: 'tool#9', name: '0.1 mm engraver', diameter: 0.1 };
    const sim = simulate(
      {
        toolpath: {
          start: [10, 20, 5],
          entries: [tc(fine), rapid([10, 20, -1]), rapid([30, 20, -1]), rapid([30, 20, 5])],
        },
        tools: [fine],
        stock,
      },
      0.01,
    );
    expect(sim.collisions().map((c) => c.move)).toEqual([0, 1]);
    expect(sim.collisions()[1]!.depth).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// The bracket: profile with tabs, a pocket, the gouge check

const setup: Setup = {
  id: 'setup#1',
  name: 'Top',
  stock: { min: [-10, -10, -6], max: [50, 30, 0] },
  wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
  frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] },
  heights: { clearance: 10, retract: 3 },
  machine: 'shapeoko-5-pro-4x4',
  post: 'grbl',
  operations: [],
};
const machineStock: Box3 = setup.stock;
const context: OperationContext = {
  generation: 1,
  cancelled: false,
  setup,
  checkpoint: () => Promise.resolve(),
};

const TABS = { count: 4, width: 6, height: 2 };

function bracketProfile(over: Partial<ProfileOperation> = {}): ProfileOperation {
  return {
    kind: 'profile',
    id: 'profile#1',
    name: 'Outline',
    tool: flat6,
    feeds,
    loops: [bracketOutline()],
    side: 'outside',
    depth: { top: 0, bottom: -BRACKET.thickness },
    stepdown: 2,
    finishAllowance: 0,
    tabs: TABS,
    entry: { kind: 'plunge' },
    leadIn: { kind: 'none' },
    leadOut: { kind: 'none' },
    climb: true,
    ...over,
  };
}

const POCKET: PocketBox = { x0: 22, y0: 4, x1: 36, y1: 16, floor: -2 };

function bracketPocket(): PocketOperation {
  return {
    kind: 'pocket',
    id: 'pocket#1',
    name: 'Recess',
    tool: flat6,
    feeds,
    loops: [
      {
        segments: [
          { kind: 'line', start: [POCKET.x0, POCKET.y0], end: [POCKET.x1, POCKET.y0] },
          { kind: 'line', start: [POCKET.x1, POCKET.y0], end: [POCKET.x1, POCKET.y1] },
          { kind: 'line', start: [POCKET.x1, POCKET.y1], end: [POCKET.x0, POCKET.y1] },
          { kind: 'line', start: [POCKET.x0, POCKET.y1], end: [POCKET.x0, POCKET.y0] },
        ],
      },
    ],
    depth: { top: 0, bottom: POCKET.floor },
    stepdown: 1,
    stepover: 0.4,
    finishAllowance: 0,
    entry: { kind: 'helix', angle: (3 * Math.PI) / 180, radius: 1.5 },
    climb: true,
  };
}

async function jobOf(ops: (ProfileOperation | PocketOperation)[]): Promise<Toolpath> {
  const jobOps: JobOperation[] = [];
  for (const op of ops) {
    const r =
      op.kind === 'profile'
        ? await generateProfile(op, context)
        : await generatePocket(op, context);
    if (!r.ok) throw new Error(r.error.message);
    jobOps.push({
      id: op.id,
      name: op.name,
      tool: op.tool,
      feeds: op.feeds,
      result: { ok: true, toolpath: r.value.toolpath },
    });
  }
  const job = assembleJob(setup, jobOps);
  if (!job.ok) throw new Error(job.error.message);
  return job.value.toolpath;
}

describe('the bracket job', () => {
  it('a profile with tabs leaves tabs of the right height, and no gouge', async () => {
    const toolpath = await jobOf([bracketProfile()]);
    const sim = simulate(
      { toolpath, tools: [flat6], stock: machineStock, part: bracketMesh() },
      0.2,
    );
    expect(sim.collisions()).toEqual([]);
    // Along the tool centre path of the last pass, the slot is at the bottom or at a tab's top.
    const bottom = -BRACKET.thickness;
    const tabTop = bottom + TABS.height;
    const cuts = movesWithStarts(toolpath).filter(
      ({ move }) => move.kind !== 'rapid' && move.op === 'profile#1',
    );
    const deepest = Math.max(...cuts.map(({ move }) => move.pass));
    const lastPass = cuts.filter(({ move }) => move.pass === deepest);
    const levels: number[] = [];
    for (const { from, move } of lastPass) {
      if (Math.abs(from[2] - move.to[2]) > 1e-9) continue; // the steps up onto and off the tabs
      for (const p of sampleMove(from, move, 0.2)) levels.push(sim.heightAt(p[0], p[1]));
    }
    expect(levels.length).toBeGreaterThan(300);
    for (const h of levels) {
      expect(Math.min(Math.abs(h - bottom), Math.abs(h - tabTop))).toBeLessThan(1e-5);
    }
    // Four runs at the tab top, each about the tab's width long along the path.
    let runs = 0;
    for (let k = 0; k < levels.length; k++) {
      const atTab = Math.abs(levels[k]! - tabTop) < 1e-5;
      const before = Math.abs(levels[(k - 1 + levels.length) % levels.length]! - tabTop) < 1e-5;
      if (atTab && !before) runs++;
    }
    expect(runs).toBe(TABS.count);
    const tabLength = levels.filter((h) => Math.abs(h - tabTop) < 1e-5).length * 0.2;
    expect(Math.abs(tabLength / TABS.count - TABS.width)).toBeLessThan(0.6);
    // The part itself is untouched: no gouge, no material left on it.
    const cmp = sim.compare()!;
    expect(cmp.gougeCells).toBe(0);
    expect(cmp.leftoverCells).toBe(0);
    expect(cmp.classes.some((c) => c === SIM_CLASS.ok)).toBe(true);
  });

  it('reports a deliberately wrong offset as a gouge', async () => {
    // The profile run as if the outline were 1 mm smaller all round.
    const wrong = bracketProfile({
      loops: [
        {
          segments: [
            { kind: 'line', start: [1, 1], end: [39, 1] },
            { kind: 'line', start: [39, 1], end: [39, 19] },
            { kind: 'line', start: [39, 19], end: [1, 19] },
            { kind: 'line', start: [1, 19], end: [1, 1] },
          ],
        },
      ],
    });
    const toolpath = await jobOf([wrong]);
    const sim = simulate(
      { toolpath, tools: [flat6], stock: machineStock, part: bracketMesh() },
      0.2,
    );
    const cmp = sim.compare()!;
    expect(cmp.gougeCells).toBeGreaterThan(100);
    expect(cmp.worstGouge!.depth).toBeCloseTo(BRACKET.thickness, 5);
    // Gouges lie in the 1 mm band inside the outline.
    const g = sim.grid;
    cmp.classes.forEach((c, k) => {
      if (c !== SIM_CLASS.gouge) return;
      const x = g.x0 + ((k % g.nx) + 0.5) * g.cell;
      const y = g.y0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
      const inset = Math.min(x, y, 40 - x, 20 - y);
      expect(inset).toBeGreaterThan(0);
      expect(inset).toBeLessThan(1);
    });
    expect(sim.report().gougeCells).toBe(cmp.gougeCells);
  });

  it('a profile and a pocket: no gouge, leftovers only in the corners a round tool cannot reach', async () => {
    const toolpath = await jobOf([bracketPocket(), bracketProfile()]);
    const sim = simulate(
      { toolpath, tools: [flat6], stock: machineStock, part: bracketMesh(POCKET) },
      0.2,
    );
    expect(sim.collisions()).toEqual([]);
    const cmp = sim.compare()!;
    expect(cmp.gougeCells).toBe(0);
    expect(cmp.leftoverCells).toBeGreaterThan(0);
    const g = sim.grid;
    cmp.classes.forEach((c, k) => {
      if (c !== SIM_CLASS.leftover) return;
      const x = g.x0 + ((k % g.nx) + 0.5) * g.cell;
      const y = g.y0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
      // Within the tool's radius of a pocket corner.
      const corner = Math.min(
        ...[
          [POCKET.x0, POCKET.y0],
          [POCKET.x1, POCKET.y0],
          [POCKET.x1, POCKET.y1],
          [POCKET.x0, POCKET.y1],
        ].map(([cx, cy]) => Math.hypot(x - cx!, y - cy!)),
      );
      expect(corner).toBeLessThan(3);
    });
    expect(sim.heightAt(29, 10)).toBeCloseTo(POCKET.floor, 6);
  });

  it('rasters the part in the setup frame', () => {
    // The bracket stood on its side in the model (model Y up becomes machine Z): back to the plate.
    const mesh = bracketMesh();
    const p = mesh.positions;
    const model = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      model[i] = p[i]!;
      model[i + 1] = p[i + 2]!; // model Y = machine Z
      model[i + 2] = -p[i + 1]!; // model Z = -machine Y
    }
    const frame = {
      origin: [0, 0, 0] as Vec3,
      xAxis: [1, 0, 0] as Vec3,
      yAxis: [0, 0, -1] as Vec3,
      zAxis: [0, 1, 0] as Vec3,
    };
    const back = meshToMachine({ positions: model, indices: mesh.indices }, frame);
    const g = { x0: -10, y0: -10, cell: 0.5, nx: 120, ny: 80 };
    const a = rasterPart(mesh, g);
    const b = rasterPart(back, g);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(a[(20 + 20) * 120 + 40]).toBe(0); // (10.25, 10.25) on the plate
    expect(a[0]).toBe(-Infinity);
  });
});

describe('the gouge check at the default cell', () => {
  // The default cell for a 6 mm tool: 0.375 mm.
  function atDefaultCell(program: SimulationProgram): MaterialSimulation {
    const r = MaterialSimulation.create(program);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.grid.cell).toBeCloseTo(0.375, 12);
    r.value.runTo(Infinity);
    return r.value;
  }
  // The stock moved by a fraction of a cell, so the cell centres land differently on the walls.
  const SHIFTS = [0, 0.05, 0.11, 0.17, 0.23, 0.29, 0.34];
  const shifted = (b: Box3, d: number): Box3 => ({
    min: [b.min[0] - d, b.min[1] - d, b.min[2]],
    max: [b.max[0], b.max[1], b.max[2]],
  });

  it('a profile 0.3 mm inside the bracket is a gouge; the exact one, fillet included, is not', async () => {
    const exact = await jobOf([bracketProfile({ tabs: { count: 0, width: 6, height: 2 } })]);
    const wrong = await jobOf([
      bracketProfile({ loops: [bracketOutline(0.3)], tabs: { count: 0, width: 6, height: 2 } }),
    ]);
    for (const d of SHIFTS) {
      const box = shifted(machineStock, d);
      const ok = atDefaultCell({
        toolpath: exact,
        tools: [flat6],
        stock: box,
        part: bracketMesh(),
      });
      const okCmp = ok.compare()!;
      expect(okCmp.gougeCells).toBe(0);
      const bad = atDefaultCell({
        toolpath: wrong,
        tools: [flat6],
        stock: box,
        part: bracketMesh(),
      });
      const cmp = bad.compare()!;
      expect(cmp.gougeCells).toBeGreaterThan(0);
      expect(cmp.worstGouge!.depth).toBeCloseTo(BRACKET.thickness, 5);
      // Every gouge lies in the 0.3 mm band inside the outline, beyond the sideways allowance.
      const g = bad.grid;
      const side = bad.sideAllowance;
      expect(side).toBeCloseTo(SIM_TOLERANCE + SIM_DEFLECTION, 12);
      cmp.classes.forEach((c, k) => {
        if (c !== SIM_CLASS.gouge) return;
        const x = g.x0 + ((k % g.nx) + 0.5) * g.cell;
        const y = g.y0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
        const round = x > 38 && y < 2 ? 2 - Math.hypot(x - 38, y - 2) : Infinity;
        const inset = Math.min(x, y, 40 - x, 20 - y, round);
        expect(inset).toBeGreaterThan(side - 1e-6);
        expect(inset).toBeLessThan(0.3);
      });
    }
  });

  it('a circular hole cut exactly is not a gouge, its chords notwithstanding; 0.3 mm over is', () => {
    // A 10 mm hole in 48 chords (standing 0.005 mm into the hole), cut with a 6 mm flat on a
    // circle of radius 2 (exact) and 2.3 (0.3 mm too big).
    const part = plateWithHole(40, 5, 6, 48);
    const hole = (r: number): Toolpath => ({
      start: [20 + r, 20, 5],
      entries: [
        tc(flat6),
        rapid([20 + r, 20, 1]),
        line([20 + r, 20, -6]),
        {
          kind: 'arc',
          to: [20 + r, 20, -6],
          center: [20, 20],
          direction: 'ccw',
          fullCircle: true,
          feed: 1000,
          feedClass: 'cut',
          op: 't',
          pass: 0,
        },
        rapid([20 + r, 20, 5]),
      ],
    });
    const box: Box3 = { min: [-5, -5, -6], max: [45, 45, 0] };
    for (const d of SHIFTS) {
      const ok = atDefaultCell({ toolpath: hole(2), tools: [flat6], stock: shifted(box, d), part });
      expect(ok.compare()!.gougeCells).toBe(0);
      const bad = atDefaultCell({
        toolpath: hole(2.3),
        tools: [flat6],
        stock: shifted(box, d),
        part,
      });
      const cmp = bad.compare()!;
      expect(cmp.gougeCells).toBeGreaterThan(10);
      expect(cmp.worstGouge!.depth).toBeCloseTo(6, 5);
      const r = Math.hypot(cmp.worstGouge!.at[0] - 20, cmp.worstGouge!.at[1] - 20);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(5.3);
    }
  });

  it('reports a gouge into a pocket floor next to its wall', async () => {
    // The pocket job, and the part's pocket 0.5 mm shallower than cut: the whole floor is a
    // gouge, right up to the walls but for the sideways allowance.
    const toolpath = await jobOf([bracketPocket()]);
    const part = bracketMesh({ ...POCKET, floor: POCKET.floor + 0.5 });
    const sim = atDefaultCell({ toolpath, tools: [flat6], stock: machineStock, part });
    const cmp = sim.compare()!;
    const g = sim.grid;
    let nearWall = 0;
    cmp.classes.forEach((c, k) => {
      const x = g.x0 + ((k % g.nx) + 0.5) * g.cell;
      const y = g.y0 + (Math.floor(k / g.nx) + 0.5) * g.cell;
      const inset = Math.min(x - POCKET.x0, y - POCKET.y0, POCKET.x1 - x, POCKET.y1 - y);
      if (inset > sim.sideAllowance && inset < 0.5 && sim.heights[k]! < POCKET.floor + 0.01) {
        expect(c).toBe(SIM_CLASS.gouge);
        nearWall++;
      }
    });
    expect(nearWall).toBeGreaterThan(20);
  });
});

describe('performance (estimate)', () => {
  it('simulates the bracket job (profile with tabs and a pocket)', async () => {
    const toolpath = await jobOf([bracketPocket(), bracketProfile()]);
    const moves = movesWithStarts(toolpath).length;
    const lines: string[] = [];
    for (const cell of [0.375, 0.1, 0.05]) {
      const times: number[] = [];
      let cells = 0;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        const sim = simulate(
          { toolpath, tools: [flat6], stock: machineStock, part: bracketMesh(POCKET) },
          cell,
        );
        sim.compare();
        times.push(performance.now() - t0);
        cells = sim.grid.nx * sim.grid.ny;
      }
      times.sort((a, b) => a - b);
      lines.push(
        `cell ${cell} mm, ${cells} cells, ${moves} moves: median ${times[1]!.toFixed(0)} ms`,
      );
      expect(times[1]!).toBeLessThan(10_000);
    }
    console.log(`sim performance: ${lines.join('; ')}`);
  }, 60_000);
});
