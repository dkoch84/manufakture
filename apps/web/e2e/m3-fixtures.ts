import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';
import { regenerated } from './bracket';
import { settle, type Vec3 } from './helpers';
import { execute } from './m2-fixtures';

// The M3 acceptance model, a cutting jig for 4 mm PTFE (Bowden) tube (docs/m3-acceptance.md),
// its dimensions and the values computed by hand, shared by the m3-*.spec.ts chapters.
//
// One part studio of two bodies, printed on a Bambu Lab X1 Carbon with a 0.4 mm nozzle and an
// AMS (the thumbscrew in a second colour). World axes: the bore runs along +X, the block's width
// is along +Y and its height along +Z, standing on its base at z = 0.
//
// The block (body `extrude#1`), #length x #width x #height = 40 x 20 x 15 mm, x 0..40, y 0..20:
// - the label "PTFE 4" on the top face, Inter Bold at a 5 mm cap height, centred at (14, 10),
//   debossed 0.6 mm (`sketch#2`, `extrude#2`);
// - the bore along x, centred at y 10, z 7.5, diameter `4 mm + #fit_slip`, through all
//   (`sketch#3` on the end plane x = 0, `extrude#3`);
// - a 0.5 mm chamfer on the bore's entry edge at x = 0 (`chamfer#1`);
// - the blade slot across the block at x = 30, `#blade + #fit_press` wide, from the top down to
//   z = 4, so it crosses the bore (`sketch#4`, `extrude#4`);
// - the side hole for the thumbscrew, from the front face y = 0 into the bore at x = 15,
//   z = 7.5, 10 mm deep (to the bore's axis), diameter `4.134 mm + #fit_slip` (`sketch#5`,
//   `extrude#5`), threaded M5, modelled, clearance #fit_slip, its whole length (`thread#1`).
//   4.134 mm is M5's basic minor diameter (ISO 724); with the clearance added it is exactly the
//   crest the thread leaves, so the thread trims nothing and the hole's own crest strips keep
//   the hole's name (kernel README, "Threads").
//
// The thumbscrew (body `extrude#6`), standing on its head at (60, 10):
// - a head 12 mm across and 5 mm high (`sketch#6`, `extrude#6`, a new body), with six lobes cut
//   out of its rim: circles 3 mm across centred on the rim, 60 degrees apart (`sketch#8`,
//   `extrude#8`);
// - a shank `5 mm - #fit_slip` across and 10 mm long on top of it (`sketch#7`, `extrude#7`),
//   threaded M5, modelled, clearance #fit_slip (`thread#2`): M5's major diameter less the
//   clearance is exactly the crest of the external thread, so again nothing is trimmed.
//
// The profiles are sketched with commands (the sketcher is M1's and its own specs cover it), with
// entity and constraint ids in blocks of their own (e101, e201, ...) so they never meet the ids
// the UI hands out. Everything else goes through the UI.

export const JIG = {
  name: 'PTFE tube jig',
  length: 40,
  width: 20,
  height: 15,
  /** A single-edge razor blade's thickness; measure your own. */
  blade: 0.3,
  /** The placeholder fit defaults at a 0.4 mm nozzle (packages/print/src/fits.ts). */
  fits: { press: 0.1, slip: 0.2, sliding: 0.4 },
  label: { text: 'PTFE 4', size: 5, depth: 0.6, at: [14, 10] as [number, number] },
  bore: { tube: 4, y: 10, z: 7.5 },
  chamfer: 0.5,
  slot: { x: 30, bottom: 4 },
  side: { x: 15, depth: 10, minor: 4.134 },
  head: { diameter: 12, height: 5, lobes: 6, lobeDiameter: 3 },
  shank: { length: 10 },
  screw: [60, 10] as [number, number],
  /** ISO 261 M5 coarse. */
  m5: { major: 5, pitch: 0.8 },
  colors: { block: '#3a7bd5', screw: '#f2a900' },
} as const;

/** Viewport ids of the two bodies. */
export const BLOCK = 'part#1/extrude#1';
export const SCREW = 'part#1/extrude#6';

// --- Volumes, by hand ------------------------------------------------------------------------

const textDir = new URL('../../../packages/text/', import.meta.url);

interface FontCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x: number;
  y: number;
  x1: number;
  y1: number;
}
interface Opentype {
  parse(buffer: ArrayBuffer): {
    tables: { os2: { sCapHeight: number } };
    charToGlyph(c: string): { path: { commands: FontCommand[] } };
  };
}

let font: ReturnType<Opentype['parse']> | null = null;

/** Inter Bold, read from the bundled file with opentype.js: independent of the app's text code. */
function interBold() {
  if (font) return font;
  const opentype = createRequire(new URL('package.json', textDir))('opentype.js') as Opentype;
  const bytes = readFileSync(new URL('fonts/Inter-Bold.ttf', textDir));
  font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return font;
}

/** Twice the signed area a glyph's contours enclose (Green's theorem), in font units squared. */
function glyphArea2(commands: readonly FontCommand[]): number {
  let a = 0;
  let start = [0, 0];
  let at = [0, 0];
  const cross = (p: number[], q: number[]) => p[0]! * q[1]! - q[0]! * p[1]!;
  for (const c of commands) {
    const to = [c.x, c.y];
    if (c.type === 'M') {
      start = to;
    } else if (c.type === 'L') {
      a += cross(at, to);
    } else if (c.type === 'Q') {
      const k = [c.x1, c.y1];
      a += (2 * cross(at, k) + 2 * cross(k, to) + cross(at, to)) / 3;
    } else if (c.type === 'Z') {
      a += cross(at, start);
      at = start;
      continue;
    } else {
      throw new Error('Inter Bold has TrueType (quadratic) outlines only');
    }
    at = to;
  }
  return a;
}

/**
 * Square millimetres of `text`'s letters at cap height `size` mm. The letters of "PTFE 4" do not
 * touch, so the area is the sum of the glyphs' (counters, in P and 4, wind the other way).
 */
export function textArea(text: string, size: number): number {
  const f = interBold();
  const scale = size / f.tables.os2.sCapHeight;
  let area = 0;
  for (const ch of text) {
    if (ch === ' ') continue;
    area += Math.abs(glyphArea2(f.charToGlyph(ch).path.commands)) / 2;
  }
  return area * scale * scale;
}

/**
 * The volume two crossing cylinders share: one of radius `a` along y, one of radius `b <= a`
 * along x whose axis it meets, counting only the half of the second on the first one's side
 * (the side hole stops at the bore's axis). For each height z the section is a rectangle
 * 2 sqrt(a^2 - z^2) by sqrt(b^2 - z^2); with z = b sin t the integrand is smooth, and the
 * midpoint rule with 20,000 steps converges to 1e-12.
 */
export function halfCrossing(a: number, b: number, n = 20_000): number {
  let s = 0;
  const h = Math.PI / n;
  for (let i = 0; i < n; i++) {
    const t = -Math.PI / 2 + (i + 0.5) * h;
    const c = Math.cos(t);
    s += 2 * Math.sqrt(a * a - b * b * Math.sin(t) ** 2) * b * b * c * c * h;
  }
  return s;
}

/** The area two circles of radii R and r overlap in, centres d apart. */
export function lens(R: number, r: number, d: number): number {
  return (
    r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r)) +
    R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R)) -
    0.5 * Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R))
  );
}

/**
 * What each feature removes from (or adds to) the jig, mm3, for a slip fit `slip`; exact except
 * the threads (`threadReference`).
 */
export function jigVolumes(slip: number = JIG.fits.slip) {
  const { length: L, width: W, height: H, blade, fits, label, chamfer: c } = JIG;
  const b = (JIG.bore.tube + slip) / 2;
  const a = (JIG.side.minor + slip) / 2;
  const w = blade + fits.press;
  const block = L * W * H;
  const text = textArea(label.text, label.size) * label.depth;
  const bore = Math.PI * b * b * L;
  // Pappus: the chamfer's triangle (legs c) revolved about the bore's axis, centroid at b + c/3.
  const chamferCut = 2 * Math.PI * (b + c / 3) * ((c * c) / 2);
  // The bore already removed the slot's share of it.
  const slot = w * W * (H - JIG.slot.bottom) - Math.PI * b * b * w;
  const side = Math.PI * a * a * JIG.side.depth - halfCrossing(a, b);
  const r = JIG.head.diameter / 2;
  const lobe = JIG.head.lobeDiameter / 2;
  const head = Math.PI * r * r * JIG.head.height;
  const lobes = JIG.head.lobes * lens(r, lobe, r) * JIG.head.height;
  const shankR = JIG.m5.major / 2 - slip / 2;
  const shank = Math.PI * shankR * shankR * JIG.shank.length;
  return {
    /** The block after each of its features, before the thread. */
    block: {
      extruded: block,
      labelled: block - text,
      bored: block - text - bore,
      chamfered: block - text - bore - chamferCut,
      slotted: block - text - bore - chamferCut - slot,
      holed: block - text - bore - chamferCut - slot - side,
    },
    screw: { head, shank: head + shank, lobed: head + shank - lobes },
    parts: { text, bore, chamfer: chamferCut, slot, side, head, lobes, shank },
    radii: { bore: b, side: a, shank: shankR },
  };
}

// --- Threads, by their profile ---------------------------------------------------------------
//
// T3.2e's reference (packages/kernel/test/threads.test.ts) is Cavalieri's: a thread open at both
// ends is helically symmetric, so its volume is its length times one cross-section. The jig's
// threads have ends (a 45 degree chamfer at the free end, a closed groove at the other) and the
// side thread runs into the bore, so the reference here integrates the material the thread
// removes over the angle t about the axis and the height z along it, with the radial part done
// exactly: at each (t, z) the groove and the chamfer leave the material beyond (or within) one
// radius, from the ISO 68-1 profile with the clearance (the kernel README, "Threads": the groove
// is P/4 wide at an external root, P/8 at an internal one, with 30 degree flanks, swept along
// the helix from one pitch before a chamfered start to its whole width inside a closed end).
// What the bore already removed is left out. The midpoint rule over 720 x 4000 cells agrees with
// a run at four times as many to 2e-7; the threads the kernel cuts agree with it to 6e-5.

const TAN30 = Math.tan(Math.PI / 6);
const H_PER_P = Math.sqrt(3) / 2;

interface Groove {
  pitch: number;
  root: number;
  rootWidth: number;
  openingWidth: number;
}

function groove(side: 'external' | 'internal', radius: number, clearance: number): Groove {
  const { major, pitch } = JIG.m5;
  const depth = (5 / 8) * H_PER_P * pitch;
  const margin = 0.05 * pitch;
  if (side === 'external') {
    const root = major / 2 - depth - clearance;
    const opening = radius + margin;
    return {
      pitch,
      root,
      rootWidth: pitch / 4,
      openingWidth: pitch / 4 + 2 * (opening - root) * TAN30,
    };
  }
  const root = major / 2 + clearance;
  const opening = radius - margin;
  return {
    pitch,
    root,
    rootWidth: pitch / 8,
    openingWidth: pitch / 8 + 2 * (root - opening) * TAN30,
  };
}

/**
 * The volume a thread's groove and end chamfer remove, mm3, for a slip fit `slip` (the thread's
 * diametral clearance; the kernel's radial clearance is half of it).
 * - `side`: the M5 internal thread in the side hole, chamfered at its mouth (z = 0, y = 0) and
 *   closed at the bore's axis (z = 10); the bore crosses it.
 * - `screw`: the M5 external thread on the shank, closed at the head (z = 0) and chamfered at the
 *   tip (z = 10).
 */
export function threadReference(which: 'side' | 'screw', slip: number, nt = 720, nz = 4000) {
  const c = slip / 2;
  const L = which === 'side' ? JIG.side.depth : JIG.shank.length;
  const radius = which === 'side' ? (JIG.side.minor + slip) / 2 : JIG.m5.major / 2 - c;
  const g = groove(which === 'side' ? 'internal' : 'external', radius, c);
  const P = g.pitch;
  const lo = which === 'side' ? -1 : g.openingWidth / 2 / P;
  const hi = which === 'side' ? L / P - g.openingWidth / 2 / P : L / P + 1;
  // The bore, in the side thread's frame: its axis meets the thread's at z = 10, square to it,
  // and the thread's angle t is measured from -X towards +Z (the kernel's frame for an internal
  // thread along +Y, phase 0), so the bore is where (z - 10)^2 + (r sin t)^2 < b^2.
  const b = (JIG.bore.tube + slip) / 2;
  const dt = (2 * Math.PI) / nt;
  const dz = L / nz;
  let v = 0;
  for (let i = 0; i < nt; i++) {
    const t = (i + 0.5) * dt;
    const turn = t / (2 * Math.PI);
    const sin = Math.abs(Math.sin(t));
    for (let j = 0; j < nz; j++) {
      const z = (j + 0.5) * dz;
      // The groove's centre line crosses this angle at tau = turn + n, at height P tau.
      let edge = which === 'side' ? 0 : Infinity;
      const n0 = Math.floor((z - g.openingWidth) / P - turn) - 1;
      for (let n = n0; n <= n0 + 4; n++) {
        const tau = turn + n;
        if (tau < lo || tau > hi) continue;
        const u = Math.abs(z - P * tau);
        if (u >= g.openingWidth / 2) continue;
        const reach = Math.max(0, u - g.rootWidth / 2) / TAN30;
        if (which === 'side') edge = Math.max(edge, g.root - reach);
        else edge = Math.min(edge, g.root + reach);
      }
      if (which === 'side') {
        // The 45 degree chamfer from the root at the mouth; the material starts at the hole.
        edge = Math.max(edge, g.root - z);
        let inner = radius;
        const s2 = b * b - (z - L) ** 2;
        if (s2 > 0) inner = Math.max(inner, sin < 1e-12 ? Infinity : Math.sqrt(s2) / sin);
        if (edge > inner) v += 0.5 * (edge * edge - inner * inner) * dt * dz;
      } else {
        edge = Math.min(edge, g.root + (L - z));
        if (edge < radius) v += 0.5 * (radius * radius - edge * edge) * dt * dz;
      }
    }
  }
  return v;
}

/** T3.2e's tolerance on a thread's volume against its reference. */
export const THREAD_TOLERANCE = 0.005;

// --- The profiles, as commands ---------------------------------------------------------------

const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

export const PLANES = {
  ground: { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  at: (z: number) => ({ type: 'plane', origin: [0, 0, z], normal: [0, 0, 1], xDir: [1, 0, 0] }),
  /** The end x = 0: sketch x is world Y, sketch y is world Z; the normal +X runs into the block. */
  end: { type: 'plane', origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] },
  /** The front y = 0: sketch x is world X, sketch y is world -Z; the normal +Y runs into the block. */
  front: { type: 'plane', origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] },
};

/** A fully constrained rectangle, as in m2-fixtures.ts; ids from e<base + 1> and k<base + 1>. */
function rectangle(
  id: string,
  name: string,
  plane: unknown,
  base: number,
  expr: { x0: string; y0: string; w: string; h: string },
  at: { x0: number; y0: number; w: number; h: number },
) {
  const c: [number, number][] = [
    [at.x0, at.y0],
    [at.x0 + at.w, at.y0],
    [at.x0 + at.w, at.y0 + at.h],
    [at.x0, at.y0 + at.h],
  ];
  const ids = [1, 2, 3, 4].map((i) => `e${base + i}`);
  const k = (i: number) => `k${base + i}`;
  const origin = { entity: '@origin' };
  const corner = { entity: ids[0], at: 'start' };
  return {
    id,
    kind: 'sketch',
    name,
    suppressed: false,
    plane,
    entities: c.map((start, i) => ({
      id: ids[i],
      kind: 'line',
      construction: false,
      start,
      end: c[(i + 1) % 4],
    })),
    constraints: [
      ...ids.map((e, i) => ({
        id: k(i + 1),
        kind: 'coincident',
        a: { entity: e, at: 'end' },
        b: { entity: ids[(i + 1) % 4], at: 'start' },
      })),
      { id: k(5), kind: 'horizontal', line: ids[0] },
      { id: k(6), kind: 'horizontal', line: ids[2] },
      { id: k(7), kind: 'vertical', line: ids[1] },
      { id: k(8), kind: 'vertical', line: ids[3] },
      { id: k(9), kind: 'horizontalDistance', a: origin, b: corner, value: mm(expr.x0) },
      { id: k(10), kind: 'verticalDistance', a: origin, b: corner, value: mm(expr.y0) },
      {
        id: k(11),
        kind: 'horizontalDistance',
        a: { entity: ids[0], at: 'start' },
        b: { entity: ids[0], at: 'end' },
        value: mm(expr.w),
      },
      {
        id: k(12),
        kind: 'verticalDistance',
        a: { entity: ids[1], at: 'start' },
        b: { entity: ids[1], at: 'end' },
        value: mm(expr.h),
      },
    ],
  };
}

/**
 * Circles, each centred on a fixed construction point with its diameter dimensioned: entity
 * ids from e<base + 1> (circle, point, circle, point, ...), constraints from k<base + 1>.
 */
function circles(
  id: string,
  name: string,
  plane: unknown,
  base: number,
  list: { at: [number, number]; diameter: string; drawn: number }[],
) {
  const entities: unknown[] = [];
  const constraints: unknown[] = [];
  list.forEach(({ at, diameter, drawn }, i) => {
    const circle = `e${base + 2 * i + 1}`;
    const point = `e${base + 2 * i + 2}`;
    entities.push(
      { id: circle, kind: 'circle', construction: false, center: at, radius: drawn / 2 },
      { id: point, kind: 'point', construction: true, position: at },
    );
    constraints.push(
      { id: `k${base + 3 * i + 1}`, kind: 'fix', point: { entity: point } },
      {
        id: `k${base + 3 * i + 2}`,
        kind: 'coincident',
        a: { entity: circle, at: 'center' },
        b: { entity: point },
      },
      { id: `k${base + 3 * i + 3}`, kind: 'diameter', entity: circle, value: mm(diameter) },
    );
  });
  return { id, kind: 'sketch', name, suppressed: false, plane, entities, constraints };
}

const s = JIG;
const sketches = {
  block: () =>
    rectangle(
      'sketch#1',
      'Block',
      PLANES.ground,
      0,
      { x0: '0 mm', y0: '0 mm', w: '#length', h: '#width' },
      { x0: 0, y0: 0, w: s.length, h: s.width },
    ),
  bore: () =>
    circles('sketch#3', 'Bore', PLANES.end, 100, [
      { at: [s.bore.y, s.bore.z], diameter: '4 mm + #fit_slip', drawn: 4.2 },
    ]),
  slot: () =>
    rectangle(
      'sketch#4',
      'Slot',
      PLANES.at(s.height),
      200,
      {
        x0: `${s.slot.x} mm - (#blade + #fit_press) / 2`,
        y0: '-1 mm',
        w: '#blade + #fit_press',
        h: '#width + 2 mm',
      },
      { x0: s.slot.x - 0.2, y0: -1, w: 0.4, h: s.width + 2 },
    ),
  side: () =>
    circles('sketch#5', 'Side hole', PLANES.front, 300, [
      { at: [s.side.x, -s.bore.z], diameter: `${s.side.minor} mm + #fit_slip`, drawn: 4.334 },
    ]),
  head: () =>
    circles('sketch#6', 'Head', PLANES.ground, 400, [
      { at: s.screw, diameter: `${s.head.diameter} mm`, drawn: s.head.diameter },
    ]),
  shank: () =>
    circles('sketch#7', 'Shank', PLANES.at(s.head.height), 410, [
      { at: s.screw, diameter: '5 mm - #fit_slip', drawn: 4.8 },
    ]),
  lobes: () =>
    circles(
      'sketch#8',
      'Lobes',
      PLANES.ground,
      420,
      Array.from({ length: s.head.lobes }, (_, i) => {
        const a = (i * 2 * Math.PI) / s.head.lobes;
        const r = s.head.diameter / 2;
        return {
          at: [s.screw[0] + r * Math.cos(a), s.screw[1] + r * Math.sin(a)] as [number, number],
          diameter: `${s.head.lobeDiameter} mm`,
          drawn: s.head.lobeDiameter,
        };
      }),
    ),
};

/** The names regen gives the faces the walkthrough picks. */
export const FACES = {
  top: 'extrude#1:cap:end',
  base: 'extrude#1:cap:start',
  end: 'extrude#1:side:e4',
  bore: 'extrude#3:side:e101',
  side: 'extrude#5:side:e301',
  headBottom: 'extrude#6:cap:start',
  shank: 'extrude#7:side:e411',
};

/** Add one of the jig's profiles to the part. */
export async function addSketch(page: Page, which: keyof typeof sketches): Promise<void> {
  const feature = sketches[which]();
  await execute(page, { type: 'addFeature', partId: 'part#1', feature }, `Add ${feature.name}`);
  await expect(page.getByTestId(`feature-${feature.id}`)).toBeVisible();
}

// --- The whole jig, quickly ------------------------------------------------------------------
// For the views and the budgets: the document the walkthrough (m3-jig.spec.ts) makes through the
// UI, made with commands, its print setup included.

/** The bundled font as the Text tool records it (ADR 0011). */
const INTER = {
  id: 'font#1',
  family: 'Inter',
  style: 'Bold',
  source: {
    kind: 'bundled',
    id: 'inter-bold',
    sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
  },
};

function extrude(id: string, sketch: string, operation: string, extent: unknown, more = {}) {
  return {
    id,
    kind: 'extrude',
    name: `Extrude ${id.split('#')[1]}`,
    suppressed: false,
    profile: { sketch },
    operation,
    extent,
    reverse: false,
    ...more,
  };
}

const blind = (d: string) => ({ type: 'blind', distance: mm(d) });

function thread(id: string, name: string, face: string, ref: string) {
  return {
    id,
    kind: 'thread',
    name,
    suppressed: false,
    face: { id: ref, ref: { face } },
    length: 'full',
    standard: { system: 'iso-metric', size: 'M5' },
    hand: 'right',
    clearance: mm('#fit_slip'),
    representation: 'modelled',
  };
}

/** The jig document, as commands. */
export function jigCommands(): unknown[] {
  const add = (feature: unknown) => ({ type: 'addFeature', partId: 'part#1', feature });
  const v = (name: string, value: number) => ({
    type: 'setVariable',
    name,
    expression: mm(`${value} mm`),
  });
  const label = {
    id: 'sketch#2',
    kind: 'sketch',
    name: 'Sketch 2',
    suppressed: false,
    plane: { type: 'face', face: { id: 'r1', ref: { face: FACES.top } } },
    entities: [
      {
        id: 'e5',
        kind: 'outline',
        construction: false,
        anchor: JIG.label.at,
        angle: 0,
        source: {
          kind: 'text',
          text: JIG.label.text,
          font: INTER.id,
          size: mm(`${JIG.label.size} mm`),
          align: { horizontal: 'center', vertical: 'middle' },
        },
      },
    ],
    constraints: [],
  };
  return [
    { type: 'renameDocument', name: JIG.name },
    { type: 'renamePart', partId: 'part#1', name: 'Jig' },
    v('length', JIG.length),
    v('width', JIG.width),
    v('height', JIG.height),
    v('blade', JIG.blade),
    v('fit_press', JIG.fits.press),
    v('fit_slip', JIG.fits.slip),
    v('fit_sliding', JIG.fits.sliding),
    { type: 'addFont', font: INTER },
    add(sketches.block()),
    add(extrude('extrude#1', 'sketch#1', 'new', { type: 'blind', distance: mm('#height') })),
    add(label),
    add(
      extrude('extrude#2', 'sketch#2', 'cut', blind(`${JIG.label.depth} mm`), {
        profile: { sketch: 'sketch#2', entities: ['e5'] },
        reverse: true,
      }),
    ),
    add(sketches.bore()),
    add(extrude('extrude#3', 'sketch#3', 'cut', { type: 'throughAll' })),
    add({
      id: 'chamfer#1',
      kind: 'chamfer',
      name: 'Chamfer 1',
      suppressed: false,
      edges: [{ id: 'r2', ref: { faces: [FACES.end, FACES.bore].sort() } }],
      distance: mm(`${JIG.chamfer} mm`),
    }),
    add(sketches.slot()),
    add(
      extrude('extrude#4', 'sketch#4', 'cut', blind(`${JIG.height - JIG.slot.bottom} mm`), {
        reverse: true,
      }),
    ),
    add(sketches.side()),
    add(extrude('extrude#5', 'sketch#5', 'cut', blind(`${JIG.side.depth} mm`))),
    add(thread('thread#1', 'Thread 1', FACES.side, 'r3')),
    add(sketches.head()),
    add(extrude('extrude#6', 'sketch#6', 'new', blind(`${JIG.head.height} mm`))),
    add(sketches.shank()),
    add(extrude('extrude#7', 'sketch#7', 'add', blind(`${JIG.shank.length} mm`))),
    add(sketches.lobes()),
    add(extrude('extrude#8', 'sketch#8', 'cut', blind(`${JIG.head.height} mm`))),
    add(thread('thread#2', 'Thread 2', FACES.shank, 'r4')),
    {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#1',
      props: { name: 'Block', color: JIG.colors.block },
    },
    {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#6',
      props: { name: 'Thumbscrew', color: JIG.colors.screw },
    },
    {
      type: 'addPrintSetup',
      setup: {
        id: 'print#1',
        name: 'Plate 1',
        printer: 'bambu-x1c',
        nozzle: 0.4,
        items: [
          {
            id: 'item#1',
            part: 'part#1',
            body: 'extrude#1',
            orientation: { kind: 'layFlat', face: { id: 'r1', ref: { face: FACES.base } } },
          },
          {
            id: 'item#2',
            part: 'part#1',
            body: 'extrude#6',
            orientation: { kind: 'layFlat', face: { id: 'r2', ref: { face: FACES.headBottom } } },
          },
        ],
      },
    },
  ];
}

/** From an empty document: the whole jig, regenerated, every feature ok. */
export async function buildJig(page: Page): Promise<void> {
  await execute(page, { type: 'batch', commands: jigCommands() }, 'Make the jig');
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture!;
      const m = hooks.model.getState();
      return (
        !m.pending &&
        m.document === hooks.document.getState().document &&
        m.parts[0]!.bodies.length === 2
      );
    },
    null,
    { timeout: 120_000 },
  );
  const statuses = await regenerated(page);
  for (const [id, st] of Object.entries(statuses)) {
    expect(st, id).toMatchObject({ status: 'ok', errors: [] });
  }
}

// --- UI helpers ------------------------------------------------------------------------------

/** Look from `eye` (a direction from the target towards the eye) at `box`, without animation. */
export async function lookAt(
  page: Page,
  eye: Vec3,
  box: { min: Vec3; max: Vec3 } = {
    min: [0, 0, 0],
    max: [JIG.length, JIG.width, JIG.height],
  },
): Promise<void> {
  await page.evaluate(
    ([e, b]) => {
      const vp = window.__manufakture!.viewport;
      vp.setViewDirection(e, false);
      vp.frameBox(b, false);
    },
    [eye, box] as const,
  );
  await settle(page);
}

/**
 * Click the first of `points` where the view picks `kind` `name` (an edge's name is its two
 * faces' names, sorted, joined by `|`).
 */
export async function pick(
  page: Page,
  kind: 'face' | 'edge',
  name: string,
  points: Vec3[],
): Promise<void> {
  await settle(page);
  const at = await page.evaluate(
    ([k, wanted, candidates]) => {
      const vp = window.__manufakture!.viewport;
      const rect = document
        .querySelector('[data-testid="viewport-canvas"]')!
        .getBoundingClientRect();
      for (const p of candidates) {
        const c = vp.projectToClient(p);
        const hit = vp.pickAt(c.x - rect.left, c.y - rect.top);
        if (hit?.kind === k && hit.name === wanted) return c;
      }
      return null;
    },
    [kind, name, points] as const,
  );
  expect(at, `a visible point of ${kind} ${name}`).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
}

/** Points round an axis: centre `c`, unit axis `n` (x, y or z), radius `r`, at offsets `along`. */
export function ring(c: Vec3, axis: 0 | 1 | 2, r: number, along: number[], step = 15): Vec3[] {
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const out: Vec3[] = [];
  for (const d of along) {
    for (let a = 0; a < 360; a += step) {
      const t = (a * Math.PI) / 180;
      const p: Vec3 = [...c];
      p[axis] = p[axis]! + d;
      p[u] = p[u]! + r * Math.cos(t);
      p[v] = p[v]! + r * Math.sin(t);
      out.push(p);
    }
  }
  return out;
}

/**
 * With nothing selected: every shown body's exact volume, by viewport id (the measure tool
 * measures each body of a part of several, and only the whole of a part of one).
 */
export async function bodyVolumes(page: Page): Promise<Record<string, number | null>> {
  await regenerated(page);
  await page.evaluate(() => window.__manufakture!.selection.getState().clear());
  await page.waitForFunction(
    () => {
      const hooks = window.__manufakture!;
      const s = hooks.measure.getState();
      const shown = hooks.viewport.info().bodies.length;
      if (s.status !== 'ready' || s.request?.targets.length !== 0) return false;
      return shown === 1 ? !!s.result?.body : s.bodies.length === shown;
    },
    null,
    { timeout: 60_000 },
  );
  return page.evaluate(() => {
    const hooks = window.__manufakture!;
    const s = hooks.measure.getState();
    const shown = hooks.viewport.info().bodies;
    if (shown.length === 1) return { [shown[0]!.id]: s.result?.body?.volume ?? null };
    return Object.fromEntries(s.bodies.map((b) => [b.bodyId, b.body?.volume ?? null]));
  });
}

/** A thread feature's report: what regen built. */
export function threadReport(page: Page, id: string) {
  return page.evaluate(
    (featureId) =>
      (
        window
          .__manufakture!.model.getState()
          .parts[0]!.features.find((f) => f.featureId === featureId) as unknown as {
          thread?: {
            bodyId: string;
            side: string;
            radius: number;
            length: number;
            start: string;
            end: string;
          };
        }
      ).thread ?? null,
    id,
  );
}

/** Wait until the print workspace has checked the setup as it is now (as print-checks does). */
export async function checked(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const p = window.__manufakture!.print!;
      const r = p.resolved();
      const a = p.analysis();
      return (
        r !== null &&
        r.items.every((i) => i.status === 'ok') &&
        p.meshesSettled() &&
        !a.running &&
        a.reply !== null
      );
    },
    null,
    { timeout: 120_000 },
  );
}

/** One drawn body of the print workspace, copied out of the page. */
export interface PrintBody {
  id: string;
  /** Face names, per face (slot i for face i + 1). */
  faceNames: string[];
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaces: number[];
  faceRanges: number[];
  placement: { rotation: [number, number, number, number]; translation: Vec3 };
}

/** The print workspace's drawn bodies (copy 0 of each item), at the mesh it checks. */
export function printBodies(page: Page): Promise<PrintBody[]> {
  return page.evaluate(() => {
    type Body = {
      id: string;
      names: string[];
      transform?: { rotation: number[]; translation: number[] };
      mesh: {
        positions: ArrayLike<number>;
        normals: ArrayLike<number>;
        indices: ArrayLike<number>;
        triangleFaces: ArrayLike<number>;
        faceRanges: ArrayLike<number>;
        faceNames: ArrayLike<number>;
      };
    };
    const bodies = (window.__manufakture!.print as unknown as { bodies(): Body[] }).bodies();
    return bodies.map((b) => ({
      id: b.id,
      faceNames: Array.from(b.mesh.faceNames, (slot) => b.names[slot] ?? ''),
      positions: Array.from(b.mesh.positions),
      normals: Array.from(b.mesh.normals),
      indices: Array.from(b.mesh.indices),
      triangleFaces: Array.from(b.mesh.triangleFaces),
      faceRanges: Array.from(b.mesh.faceRanges),
      placement: {
        rotation: (b.transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        translation: (b.transform?.translation ?? [0, 0, 0]) as Vec3,
      },
    }));
  }) as Promise<PrintBody[]>;
}

/** The Issues list, each issue with the names of the faces it is about. */
export function printIssues(page: Page) {
  return page.evaluate(() => {
    type Issue = {
      kind: string;
      itemId: string;
      worst: string;
      detail: string;
      targets: { viewId: string; faces: number[] }[];
    };
    type Body = { id: string; names: string[]; mesh: { faceNames: ArrayLike<number> } };
    const p = window.__manufakture!.print as unknown as { issues(): Issue[]; bodies(): Body[] };
    const bodies = p.bodies();
    return p.issues().map((i) => ({
      kind: i.kind,
      itemId: i.itemId,
      worst: i.worst,
      detail: i.detail,
      faces: i.targets.flatMap((t) => {
        const b = bodies.find((x) => x.id === t.viewId)!;
        return t.faces.map((f) => b.names[b.mesh.faceNames[f - 1]!] ?? `?${f}`);
      }),
    }));
  });
}
