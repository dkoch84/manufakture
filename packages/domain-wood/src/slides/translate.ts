// The slide feature, `wood.slide` (#1200): one drawer slide from the hardware catalog, placed
// between a cabinet's board and a drawer's side. It makes two bodies, the slide's cabinet member
// (`<id>:slide/cabinet`) and its drawer member (`<id>:slide/drawer`), boxes filling the room the
// real part takes, so the slide shows in renders, measures and interference checks, and an
// assembly can put the drawer member in the drawer's instance. It cuts nothing.
//
// Everything is found from the two boards' frames (as a joint's is), so the slide follows them.
// The model is square to the world, Z up: the drawer pulls out along `opens` (+x, -x, +y or -y),
// both boards stand with their thickness across that (a cabinet side and a drawer side), and the
// slide's front is the drawer side's front end, less `setback`.
//
// The fit is the family's clearance model (`catalog.ts`), checked, never assumed:
//
// - side-mount: the gap between the boards is the slide's side space (12.7 mm, up to 13.5); the
//   two members fill it half each, centred on the drawer side's height (`offset` moves it up).
// - undermount: the drawer side is 12 to 16 mm thick and its inner face 21 mm from the cabinet
//   side (within the locking device's 1.5 mm); the runner sits in the 14 mm under the drawer side
//   and reaches 37 mm in, and the rail runs in the 13 mm recess under the drawer bottom, so a
//   bottom not recessed or a back not notched shows as an overlap of the rail and that board.
//
// A gap out of range, a side too thin or thick, a drawer side shorter than the slide's drawer
// member or a cabinet board not deep enough for the cabinet member is an error on the feature,
// naming the numbers. The result's metadata carries the slide (for the cut list's hardware line),
// the fit as built, the screw holes in world coordinates, and what the drawer needs that the
// slide does not check (an undermount's notch and recess).

import type { ExtrudeInput, Vec3 } from '@manufakture/kernel';
import type {
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
  JsonValue,
} from '@manufakture/regen';
import { BOARD_TYPE, readBoardMetadata } from '../board';
import { Refusal } from '../joints/common';
import { boardOf, type Board } from '../joints/geometry';
import type { Json } from '../migrations';
import { isObject, own, type Path } from '../read';
import {
  findSlideFamily,
  findSlideSize,
  type SideMountClearance,
  type UndermountClearance,
} from './catalog';
import {
  MOUNT_EXPRESSIONS,
  SLIDE_EXPRESSIONS,
  SLIDE_SCHEMA_VERSION,
  readSlideParams,
  type SlideParams,
} from './params';

/** What a slide reports in its feature result (`FeatureResult.metadata`). */
export interface SlideMetadata {
  kind: 'slide';
  family: string;
  size: string;
  /** The bill of materials item (the family's). */
  item: string;
  /** The board it is screwed to, and the drawer side. */
  cabinet: string;
  drawer: string;
  /** The bodies it makes. */
  bodies: { cabinet: string; drawer: string };
  /** The nominal length and the travel, mm. */
  nominal: number;
  travel: number;
  /** The unit world direction the drawer pulls out along. */
  opens: Vec3;
  /**
   * The fit as built, mm: `gap` between the boards, `required` and `tolerance` (the gap the
   * family asks for, and how far off it may be), `sideThickness`, `front` (the slide's front
   * along `opens`), `setback`, and the lengths of the members.
   */
  fit: Record<string, number>;
  /** Screw holes, world mm: on the cabinet board's face, and on the drawer side's. */
  holes: { cabinet: Vec3[]; drawer: Vec3[] };
  /** What the drawer needs that the slide does not check, in words. */
  requires: string[];
  /** Whether the family's numbers were checked against a real part. */
  verified: boolean;
}

/** A slide's metadata from a feature result, or undefined when it is not one. */
export function readSlideMetadata(v: unknown): SlideMetadata | undefined {
  if (!isObject(v) || own(v, 'kind') !== 'slide') return undefined;
  const bodies = own(v, 'bodies');
  const fit = own(v, 'fit');
  const holes = own(v, 'holes');
  const requires = own(v, 'requires');
  const points = (x: unknown) =>
    Array.isArray(x) &&
    x.every((p) => Array.isArray(p) && p.length === 3 && p.every((c) => typeof c === 'number'));
  if (
    !['family', 'size', 'item', 'cabinet', 'drawer'].every((k) => typeof own(v, k) === 'string') ||
    typeof own(v, 'nominal') !== 'number' ||
    typeof own(v, 'travel') !== 'number' ||
    typeof own(v, 'verified') !== 'boolean' ||
    !points([own(v, 'opens')]) ||
    !isObject(bodies) ||
    typeof own(bodies, 'cabinet') !== 'string' ||
    typeof own(bodies, 'drawer') !== 'string' ||
    !isObject(fit) ||
    !Object.values(fit).every((x) => typeof x === 'number') ||
    !isObject(holes) ||
    !points(own(holes, 'cabinet')) ||
    !points(own(holes, 'drawer')) ||
    !Array.isArray(requires) ||
    !requires.every((r) => typeof r === 'string')
  ) {
    return undefined;
  }
  return structuredClone(v) as unknown as SlideMetadata;
}

type Failure = Extract<ExtensionOutput, { error: string }>;
type V3 = [number, number, number];

/** Two lengths closer than this (mm) are the same. */
const TOL = 1e-6;
/** How far from 1 a cosine may be for an axis to count as a world axis. */
const SQUARE_TOL = 1e-9;
const AXIS = ['x', 'y', 'z'] as const;

/** Round to 0.1 micrometre, so world numbers carry no float noise. */
const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const mm = (v: number) => `${Math.round(v * 100) / 100} mm`;
/** `word` with its indefinite article: `an undermount-concealed`, `a 16 mm`, `an 8 mm`. */
const an = (word: string) => `${/^(?:[aeiou]|8|1[18](?![0-9]))/i.test(word) ? 'an' : 'a'} ${word}`;

/** A board's blank as a world box, its thickness along `thickness` (a world axis index). */
interface Box {
  id: string;
  lo: V3;
  hi: V3;
  thickness: number;
}

/** The world axis an axis lies along, or undefined when it is not square to the world. */
function worldAxis(v: readonly number[]): number | undefined {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Math.abs(v[i]!) - 1) <= SQUARE_TOL) return i;
  }
  return undefined;
}

function boxOf(b: Board, field: Path): Box {
  const axes = b.axes.map(worldAxis);
  if (axes.some((a) => a === undefined)) {
    throw new Refusal(
      `${b.id} is not square to the world: a slide goes between boards whose faces face along x, y or z`,
      field,
    );
  }
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const i of [0, 1]) {
    for (const j of [0, 1]) {
      for (const k of [0, 1]) {
        for (let c = 0; c < 3; c++) {
          const p =
            b.origin[c]! +
            i * b.size[0] * b.axes[0][c]! +
            j * b.size[1] * b.axes[1][c]! +
            k * b.size[2] * b.axes[2][c]!;
          lo[c] = Math.min(lo[c]!, p);
          hi[c] = Math.max(hi[c]!, p);
        }
      }
    }
  }
  return { id: b.id, lo, hi, thickness: axes[2]! };
}

/** The frame of the board the slide names, as a world box, or why it cannot be read. */
function boardFor(ctx: ExtensionContext<SlideParams>, key: 'cabinet' | 'drawer'): Box {
  const id = ctx.params[key];
  if (!ctx.bodies.includes(id)) {
    throw new Refusal(`${id} is not a body at this point (deleted, merged, or after the slide)`, [
      'params',
      key,
    ]);
  }
  const up = ctx.upstream.get(id);
  if (up === undefined) {
    throw new Refusal(
      `${id} is not a board this slide depends on: a slide goes between boards (wood.board features), listed in dependsOn`,
      ['dependsOn'],
    );
  }
  if (up.type !== BOARD_TYPE)
    throw new Refusal(`${id} is a ${up.type}, not a board`, ['params', key]);
  const meta = readBoardMetadata(up.metadata);
  if (meta === undefined) throw new Refusal(`${id} reports no board frame`, ['params', key]);
  return boxOf(boardOf(id, meta.frame), ['params', key]);
}

/**
 * A world box as one `new` extrude of the slide, along `lat`, its sides named under `key`. Not
 * rounded: the members meet the boards' faces exactly.
 */
function member(
  id: string,
  key: 'cabinet' | 'drawer',
  lat: 0 | 1,
  along: 0 | 1,
  front: number,
  lo: V3,
  hi: V3,
): ExtrudeInput {
  const normal: V3 = [0, 0, 0];
  normal[lat] = 1;
  // x = z cross normal, so the sketch's y is world up (+z).
  const xDir: V3 = lat === 0 ? [0, 1, 0] : [-1, 0, 0];
  const origin: V3 = [0, 0, 0];
  origin[lat] = lo[lat]!;
  const s = xDir[along]!;
  const u0 = Math.min(s * lo[along]!, s * hi[along]!) + 0;
  const u1 = Math.max(s * lo[along]!, s * hi[along]!) + 0;
  const v0 = lo[2];
  const v1 = hi[2];
  const frontAtU1 = Math.abs(s * front - u1) < Math.abs(s * front - u0);
  const line = (name: string, start: [number, number], end: [number, number]) => ({
    kind: 'line' as const,
    id: `${key}.${name}`,
    start,
    end,
  });
  return {
    kind: 'extrude',
    id,
    body: `${id}:slide/${key}`,
    capRole: `cap.${key}`,
    profile: {
      frame: { origin, xDir, normal },
      loops: [
        {
          entities: [
            line('bottom', [u0, v0], [u1, v0]),
            line(frontAtU1 ? 'front' : 'back', [u1, v0], [u1, v1]),
            line('top', [u1, v1], [u0, v1]),
            line(frontAtU1 ? 'back' : 'front', [u0, v1], [u0, v0]),
          ],
        },
      ],
    },
    extent: { type: 'blind', distance: hi[lat]! - lo[lat]! },
    mode: 'new',
  };
}

interface Built {
  inputs: ExtrudeInput[];
  metadata: SlideMetadata;
}

function build(ctx: ExtensionContext<SlideParams>): Built {
  const f = ctx.feature;
  const p = ctx.params;
  const family = findSlideFamily(p.family)!;
  const size = findSlideSize(family, p.size)!;
  if (f.operation !== 'new') {
    throw new Refusal(
      'a slide makes bodies of its own (its two members): its operation must be "new"',
      ['operation'],
    );
  }
  if (f.scope !== undefined) {
    throw new Refusal('a slide cuts nothing: it has no scope', ['scope']);
  }
  for (const name of Object.keys(f.expressions).sort()) {
    if (!MOUNT_EXPRESSIONS[family.mount].includes(name)) {
      throw new Refusal(
        `${family.mount === 'side' ? 'a side-mount' : 'an undermount'} slide has no "${name}" value`,
        ['expressions', name],
      );
    }
  }
  const setback = ctx.values.setback ?? 0;
  if (!(setback >= 0) || !Number.isFinite(setback)) {
    throw new Refusal('the setback must be zero or more', ['expressions', 'setback']);
  }
  const offset = ctx.values.offset ?? 0;
  if (!Number.isFinite(offset))
    throw new Refusal('the offset is not a number', ['expressions', 'offset']);

  const cabinet = boardFor(ctx, 'cabinet');
  const drawer = boardFor(ctx, 'drawer');
  const along: 0 | 1 = p.opens.endsWith('x') ? 0 : 1;
  const lat: 0 | 1 = along === 0 ? 1 : 0;
  const sign = p.opens.startsWith('+') ? 1 : -1;
  for (const [b, key] of [
    [cabinet, 'cabinet'],
    [drawer, 'drawer'],
  ] as const) {
    if (b.thickness !== lat) {
      throw new Refusal(
        `${b.id} does not stand along the drawer's travel: with the drawer opening along ${p.opens}, the ${key} board's thickness must run along ${AXIS[lat]}, and it runs along ${AXIS[b.thickness]}`,
        ['params', key],
      );
    }
  }

  // Across: the cabinet board on one side of the drawer side, with a gap between them.
  let dir: 1 | -1;
  let cabinetFace: number;
  let drawerFace: number;
  if (cabinet.lo[lat] >= drawer.hi[lat] - TOL) {
    dir = 1;
    cabinetFace = cabinet.lo[lat];
    drawerFace = drawer.hi[lat];
  } else if (drawer.lo[lat] >= cabinet.hi[lat] - TOL) {
    dir = -1;
    cabinetFace = cabinet.hi[lat];
    drawerFace = drawer.lo[lat];
  } else {
    throw new Refusal(`${drawer.id} overlaps ${cabinet.id}: the slide needs a gap between them`, [
      'params',
      'drawer',
    ]);
  }
  const gap = Math.max(0, dir * (cabinetFace - drawerFace));
  const sideThickness = drawer.hi[lat] - drawer.lo[lat];

  // Along: the slide's front is the drawer side's front end, set back.
  const drawerFront = sign > 0 ? drawer.hi[along] : drawer.lo[along];
  const front = drawerFront - sign * setback;
  /** How far a box runs back from the slide's front. */
  const behind = (b: Box) => (sign > 0 ? front - b.lo[along] : b.hi[along] - front);
  const ahead = (b: Box) => (sign > 0 ? b.hi[along] - front : front - b.lo[along]);
  const label = `${family.id} ${size.id}`;
  if (ahead(cabinet) < -TOL) {
    throw new Refusal(
      `the slide's front is ${mm(-ahead(cabinet))} in front of ${cabinet.id}'s front end: set it back (the setback value)`,
      ['expressions', 'setback'],
    );
  }
  if (behind(cabinet) < size.minCabinetDepth - TOL) {
    throw new Refusal(
      `the ${label} slide needs ${mm(size.minCabinetDepth)} of ${cabinet.id} behind its front, and there is ${mm(behind(cabinet))}: the cabinet is too shallow for it, so pick a shorter size or a deeper cabinet`,
      ['params', 'size'],
    );
  }
  if (behind(drawer) < size.drawerLength - TOL) {
    throw new Refusal(
      `the ${label} slide's drawer member is ${mm(size.drawerLength)} long, and ${drawer.id} runs only ${mm(behind(drawer))} back from the slide's front: pick a shorter size`,
      ['params', 'size'],
    );
  }
  /** A world box from across (two lat values), along from the front for `length`, and z. */
  const box = (a: number, b: number, length: number, z0: number, z1: number): [V3, V3] => {
    const lo: V3 = [0, 0, z0];
    const hi: V3 = [0, 0, z1];
    lo[lat] = Math.min(a, b);
    hi[lat] = Math.max(a, b);
    lo[along] = sign > 0 ? front - length : front;
    hi[along] = sign > 0 ? front : front + length;
    return [lo, hi];
  };
  const point = (across: number, back: number, z: number): Vec3 => {
    const q: V3 = [0, 0, r4(z)];
    q[lat] = r4(across);
    q[along] = r4(front - sign * back);
    return q;
  };
  const opens: V3 = [0, 0, 0];
  opens[along] = sign;
  const fit: Record<string, number> = {
    gap: r4(gap),
    sideThickness: r4(sideThickness),
    front: r4(sign * front),
    setback: r4(setback),
    cabinetLength: size.cabinetLength,
    drawerLength: size.drawerLength,
  };

  let cabinetBox: [V3, V3];
  let drawerBox: [V3, V3];
  let holes: SlideMetadata['holes'];
  const requires: string[] = [];
  if (family.clearance.kind === 'side-mount') {
    const c: SideMountClearance = family.clearance;
    if (gap < c.side.min - TOL || gap > c.side.max + TOL) {
      throw new Refusal(
        `the gap between ${cabinet.id} and ${drawer.id} is ${mm(gap)}, and ${an(family.id)} slide needs ${mm(c.side.min)} to ${mm(c.side.max)}: make the drawer ${gap > c.side.max ? 'wider' : 'narrower'}`,
        ['params', 'drawer'],
      );
    }
    const mid = (drawer.lo[2] + drawer.hi[2]) / 2 + offset;
    const z0 = mid - c.height / 2;
    const z1 = mid + c.height / 2;
    for (const b of [drawer, cabinet]) {
      if (z0 < b.lo[2] - TOL || z1 > b.hi[2] + TOL) {
        throw new Refusal(
          `the slide is ${mm(c.height)} high, from ${mm(z0)} to ${mm(z1)} up, and ${b.id} spans ${mm(b.lo[2])} to ${mm(b.hi[2])}: it does not fit on it`,
          b === drawer ? ['expressions', 'offset'] : ['params', 'cabinet'],
        );
      }
    }
    const split = cabinetFace - (dir * gap) / 2;
    cabinetBox = box(cabinetFace, split, size.cabinetLength, z0, z1);
    drawerBox = box(split, drawerFace, size.drawerLength, z0, z1);
    holes = {
      cabinet: size.holes.cabinet.map((d) => point(cabinetFace, d, mid)),
      drawer: size.holes.drawer.map((d) => point(drawerFace, d, mid)),
    };
    Object.assign(fit, {
      required: c.side.nominal,
      tolerance: r4(c.side.max - c.side.nominal),
      height: c.height,
      offset: r4(offset),
    });
  } else {
    const c: UndermountClearance = family.clearance;
    if (sideThickness < c.sideThickness.min - TOL || sideThickness > c.sideThickness.max + TOL) {
      throw new Refusal(
        `${drawer.id} is ${mm(sideThickness)} thick, and ${an(family.id)} slide takes drawer sides ${mm(c.sideThickness.min)} to ${mm(c.sideThickness.max)} thick`,
        ['params', 'drawer'],
      );
    }
    const required = c.sideReach - sideThickness;
    if (Math.abs(gap - required) > c.sideAdjust + TOL) {
      throw new Refusal(
        `the gap between ${cabinet.id} and ${drawer.id} is ${mm(gap)}, and with ${an(mm(sideThickness))} drawer side ${an(family.id)} slide needs ${mm(required)} (within ${mm(c.sideAdjust)}): the drawer's inside is ${mm(2 * c.sideReach)} narrower than the opening`,
        ['params', 'drawer'],
      );
    }
    const bottom = drawer.lo[2];
    if (cabinet.lo[2] > bottom - c.bottomClearance + TOL) {
      throw new Refusal(
        `the runner needs ${mm(c.bottomClearance)} under ${drawer.id}, down to ${mm(bottom - c.bottomClearance)}, and ${cabinet.id} ends at ${mm(cabinet.lo[2])}: raise the drawer`,
        ['params', 'cabinet'],
      );
    }
    const reach = cabinetFace - dir * c.runnerWidth;
    const inner = drawerFace - dir * sideThickness;
    cabinetBox = box(cabinetFace, reach, size.cabinetLength, bottom - c.bottomClearance, bottom);
    drawerBox = box(inner, reach, size.drawerLength, bottom, bottom + c.bottomRecess);
    holes = {
      cabinet: size.holes.cabinet.map((d) => point(cabinetFace, d, bottom - c.bottomClearance / 2)),
      drawer: [],
    };
    Object.assign(fit, {
      required: r4(required),
      tolerance: c.sideAdjust,
      bottomRecess: c.bottomRecess,
      bottomClearance: c.bottomClearance,
      topClearance: c.topClearance,
      backNotchWidth: c.backNotch.width,
      backNotchHeight: c.backNotch.height,
    });
    requires.push(
      `Recess the drawer bottom at least ${mm(c.bottomRecess)} above the sides' bottom edges`,
      `Notch the drawer back ${mm(c.backNotch.width)} wide by ${mm(c.backNotch.height)} high at each bottom corner`,
      `Leave at least ${mm(c.topClearance)} above the drawer sides`,
      "Bore the locking devices under the drawer front and the rear hooks in the drawer back from the maker's template",
    );
  }

  const id = f.id;
  const metadata: SlideMetadata = {
    kind: 'slide',
    family: family.id,
    size: size.id,
    item: family.item,
    cabinet: cabinet.id,
    drawer: drawer.id,
    bodies: { cabinet: `${id}:slide/cabinet`, drawer: `${id}:slide/drawer` },
    nominal: size.nominal,
    travel: size.travel,
    opens,
    fit,
    holes,
    requires,
    verified: family.verified,
  };
  return {
    inputs: [
      member(id, 'cabinet', lat, along, front, ...cabinetBox),
      member(id, 'drawer', lat, along, front, ...drawerBox),
    ],
    metadata,
  };
}

/** The two members' inputs and the slide's metadata, or why it cannot be placed. */
export function translateSlide(ctx: ExtensionContext<SlideParams>): ExtensionOutput {
  try {
    const out = build(ctx);
    return { inputs: out.inputs, metadata: out.metadata as unknown as JsonValue };
  } catch (error) {
    if (error instanceof Refusal) {
      return { error: error.message, field: error.field } satisfies Failure;
    }
    throw error;
  }
}

/** The `wood.slide` extension type, as regen's registry takes it. */
export const slideType: ExtensionType<SlideParams> = {
  schemaVersion: SLIDE_SCHEMA_VERSION,
  expressions: SLIDE_EXPRESSIONS,
  // The two boards it goes between.
  idFields: [
    { path: ['cabinet'], kind: 'feature' },
    { path: ['drawer'], kind: 'feature' },
  ],
  params(params, schemaVersion) {
    return readSlideParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateSlide(ctx);
  },
};
