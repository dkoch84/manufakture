// Framing members in the viewport, minus the GPU (ADR 0015 decision 4, T6.5a's findings).
// Members are data, not bodies: regen sends one mesh per distinct member shape (worker-wide,
// added and removed incrementally) and, per framing group, the members with one matrix each.
// This module keeps that data as the viewport shows it, lays the instances out into one batch
// per shape (one `InstancedMesh` each, so a house of 834 members is about 108 draw calls), gives
// every instance a pick id from a range of its own, and holds the rules for the level cut, layer
// visibility and the one LOD rule the spike asked for. Everything here is testable without WebGL;
// `memberObjects.ts` turns it into three.js objects.

import type {
  MemberCut,
  MemberData,
  MemberInstances,
  MemberMeshData,
  MemberMeshUpdate,
  MemberSetResult,
  JsonValue,
} from '@manufakture/regen';
import type { SelectableItem } from '../state/selection';

// Selection ---------------------------------------------------------------------------------

/** The selection kind of a framing member: picked as a whole, never a face of it. */
export const MEMBER_KIND = 'member';

/**
 * A picked member, by its full id `<owner feature id>:<member id>` (ADR 0015 decision 6). Not a
 * `GeometryRef`, so tools that work on B-rep geometry (measure, references) never see it.
 */
export interface MemberRef extends SelectableItem {
  kind: typeof MEMBER_KIND;
  /** The full id. */
  id: string;
  /** The feature that owns it: the full id up to its first `:`. */
  owner: string;
}

export function memberRef(fullId: string): MemberRef {
  const colon = fullId.indexOf(':');
  return { kind: MEMBER_KIND, id: fullId, owner: colon < 0 ? fullId : fullId.slice(0, colon) };
}

export function isMemberRef(item: SelectableItem | null): item is MemberRef {
  return item !== null && item.kind === MEMBER_KIND && 'owner' in item;
}

// Pick ids ----------------------------------------------------------------------------------

/**
 * Pick ids are 24-bit (picking.ts). Bodies take theirs from 1 upwards, one per face, edge and
 * vertex; members take a range of their own, one per instance, so the two never collide (bodies
 * would need over 4 million faces, edges and vertices to reach it). The range ends at 2^23:
 * the pick shader rounds with `floor(id + 0.5)`, which float32 cannot do exactly from 2^23 up,
 * where the spacing of floats is 1 and `id + 0.5` rounds to even (T6.5c found odd ids read back
 * one too high there).
 */
export const MEMBER_PICK_BASE = 0x400000;
export const MEMBER_PICK_END = 0x800000;
/** How many members can be picked; any beyond draw but pick as the background. */
export const MAX_PICKABLE_MEMBERS = MEMBER_PICK_END - MEMBER_PICK_BASE;

/** The pick id of the member in pick slot `slot`, or 0 (background) past the range. */
export function memberPickId(slot: number): number {
  return slot >= 0 && slot < MAX_PICKABLE_MEMBERS ? MEMBER_PICK_BASE + slot : 0;
}

/** The pick slot a pick id stands for, or null when it is not a member's. */
export function memberSlotOf(id: number): number | null {
  return id >= MEMBER_PICK_BASE && id < MEMBER_PICK_END ? id - MEMBER_PICK_BASE : null;
}

// The viewport's member data ------------------------------------------------------------------

/** One framing group's members as the viewport keeps them (the last data regen sent for it). */
export interface MemberSetView {
  group: string;
  namespace: string;
  features: readonly string[];
  members: readonly MemberData[];
  instances: readonly MemberInstances[];
  /** What the domain's member stage reported with the set (a wall's opening headers). */
  metadata?: JsonValue;
}

/** What the viewport draws: the shape meshes by key, and the active part's member sets. */
export interface MemberView {
  meshes: ReadonlyMap<string, MemberMeshData>;
  sets: readonly MemberSetView[];
}

export const EMPTY_MEMBER_VIEW: MemberView = { meshes: new Map(), sets: [] };

/** The meshes after a regen's update; the same map when nothing changed. */
export function applyMeshUpdate(
  meshes: ReadonlyMap<string, MemberMeshData>,
  update: MemberMeshUpdate | undefined,
): ReadonlyMap<string, MemberMeshData> {
  if (!update || (update.added.length === 0 && update.removed.length === 0)) return meshes;
  const next = new Map(meshes);
  for (const key of update.removed) next.delete(key);
  for (const m of update.added) {
    next.set(m.key, { positions: m.positions, normals: m.normals, indices: m.indices });
  }
  return next;
}

/**
 * A part's sets after a regen: a set that `changed` carries its members and instances; one that
 * did not keeps what the viewport had for its group (the same object, so nothing is rebuilt);
 * a group absent from the result is gone. The same array when nothing changed.
 */
export function applySetResults(
  previous: readonly MemberSetView[],
  results: readonly MemberSetResult[] | undefined,
): readonly MemberSetView[] {
  const list = results ?? [];
  const byGroup = new Map(previous.map((s) => [s.group, s]));
  const next: MemberSetView[] = [];
  for (const r of list) {
    if (r.changed && r.members !== null && r.instances !== null) {
      next.push({
        group: r.group,
        namespace: r.namespace,
        features: r.features,
        members: r.members,
        instances: r.instances,
        ...(r.metadata === undefined ? {} : { metadata: r.metadata }),
      });
      continue;
    }
    const kept = byGroup.get(r.group);
    // An unchanged set the viewport never saw cannot be drawn; it comes with the next change.
    if (kept) next.push(kept);
  }
  const same = next.length === previous.length && next.every((s, i) => s === previous[i]);
  return same ? previous : next;
}

/** The member with a full id, and its set, or null. */
export function findMember(
  view: MemberView,
  fullId: string,
): { set: MemberSetView; member: MemberData } | null {
  for (const set of view.sets) {
    for (const member of set.members) {
      if (`${member.owner}:${member.id}` === fullId) return { set, member };
    }
  }
  return null;
}

// Instance bookkeeping ------------------------------------------------------------------------

/** The members of every set that share a shape: what one `InstancedMesh` draws. */
export interface MemberBatch {
  shape: string;
  /** Per instance: the full id, role and set (index in `MemberView.sets`). */
  ids: string[];
  roles: string[];
  sets: number[];
  /** A column-major 4x4 per instance, member to world. */
  matrices: Float32Array;
  /** The pick slot of the first instance; the others follow in order. */
  slotBase: number;
  /** The instance lists it was made from, in order: equal lists, an equal batch. */
  sources: readonly MemberInstances[];
}

export interface MemberLayout {
  batches: MemberBatch[];
  /** Full id to its batch and instance index. */
  locate: Map<string, { batch: number; index: number }>;
  /** Pick slot to full id. */
  slots: string[];
  /** Shape keys members use that have no mesh (not drawn; regen sends a mesh before its use). */
  missing: string[];
}

/** Lay out a view's instances: one batch per shape, in order of first use, pick slots in order. */
export function layoutMembers(view: MemberView): MemberLayout {
  const byShape = new Map<string, { sources: MemberInstances[]; sets: number[] }>();
  const missing = new Set<string>();
  view.sets.forEach((set, s) => {
    for (const list of set.instances) {
      if (!view.meshes.has(list.shape)) {
        missing.add(list.shape);
        continue;
      }
      let entry = byShape.get(list.shape);
      if (!entry) byShape.set(list.shape, (entry = { sources: [], sets: [] }));
      entry.sources.push(list);
      entry.sets.push(s);
    }
  });
  const batches: MemberBatch[] = [];
  const locate = new Map<string, { batch: number; index: number }>();
  const slots: string[] = [];
  for (const [shape, { sources, sets }] of byShape) {
    const count = sources.reduce((n, l) => n + l.ids.length, 0);
    const matrices = new Float32Array(count * 16);
    const batch: MemberBatch = {
      shape,
      ids: [],
      roles: [],
      sets: [],
      matrices,
      slotBase: slots.length,
      sources,
    };
    sources.forEach((list, k) => {
      matrices.set(list.matrices.subarray(0, list.ids.length * 16), batch.ids.length * 16);
      list.ids.forEach((id, i) => {
        locate.set(id, { batch: batches.length, index: batch.ids.length });
        batch.ids.push(id);
        batch.roles.push(list.roles[i] ?? '');
        batch.sets.push(sets[k]!);
        slots.push(id);
      });
    });
    batches.push(batch);
  }
  return { batches, locate, slots, missing: [...missing] };
}

/** Whether two batches draw the same instances (so the GPU buffers can stay). */
export function sameBatch(a: MemberBatch, b: MemberBatch): boolean {
  return (
    a.shape === b.shape &&
    a.sources.length === b.sources.length &&
    a.sources.every((s, i) => s === b.sources[i])
  );
}

/** The world box of a batch's instances, from the shape's own box; null when empty. */
export function batchBounds(
  batch: MemberBatch,
  mesh: MemberMeshData,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const p = mesh.positions;
  if (p.length < 3 || batch.ids.length === 0) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[i + a]!);
      hi[a] = Math.max(hi[a]!, p[i + a]!);
    }
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const m = batch.matrices;
  for (let k = 0; k < batch.ids.length; k++) {
    const o = k * 16;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? hi[0]! : lo[0]!;
      const y = c & 2 ? hi[1]! : lo[1]!;
      const z = c & 4 ? hi[2]! : lo[2]!;
      for (let a = 0; a < 3; a++) {
        const w = m[o + a]! * x + m[o + 4 + a]! * y + m[o + 8 + a]! * z + m[o + 12 + a]!;
        if (w < min[a]!) min[a] = w;
        if (w > max[a]!) max[a] = w;
      }
    }
  }
  return { min, max };
}

// Colours -----------------------------------------------------------------------------------

/** Lumber tones by role, so plates, studs, headers and rafters read apart. */
const ROLE_COLORS: Readonly<Record<string, string>> = {
  'bottom-plate': '#c49a63',
  'top-plate': '#c49a63',
  stud: '#e0c39a',
  corner: '#e0c39a',
  backing: '#e0c39a',
  king: '#d6b07d',
  jack: '#cfa36c',
  header: '#b78450',
  'header-spacer': '#b78450',
  'rough-sill': '#cfa36c',
  cripple: '#e6cfa9',
  blocking: '#e6cfa9',
  joist: '#d2a776',
  rim: '#bf915e',
  skid: '#9c7a52',
  'common-rafter': '#c99a66',
  'jack-rafter': '#c99a66',
  'hip-rafter': '#ad7a46',
  'fly-rafter': '#c99a66',
  ridge: '#ad7a46',
  'ceiling-joist': '#d2a776',
  'rafter-tie': '#d2a776',
  'gable-stud': '#e0c39a',
  'sub-fascia': '#a7774a',
  fascia: '#a7774a',
};

export const DEFAULT_MEMBER_COLOR = '#dcbf94';

export function memberColor(role: string): string {
  return ROLE_COLORS[role] ?? DEFAULT_MEMBER_COLOR;
}

/** A role as the info panel names it: `top-plate` is "Top plate". */
export function roleLabel(role: string): string {
  const words = role.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Level cut ---------------------------------------------------------------------------------

/** Where a plan cuts by default: 4' above the level (ADR 0015 decision 11). */
export const PLAN_CUT_HEIGHT = 1219.2;

/** A plate sitting on the level is not cut away by float noise. */
export const LEVEL_TOLERANCE = 0.5;

/**
 * Show one level as a plan does (levels are constant elevations, ADR 0015 decision 2): cut away
 * everything above `elevation + cutHeight` and, with `below`, everything lower than `below` under
 * the elevation (0: nothing under the level, so lower levels are hidden). Bodies and members are
 * clipped alike. All in mm, z up.
 */
export interface LevelCut {
  elevation: number;
  /** Above the elevation; default `PLAN_CUT_HEIGHT`; null: no top cut. */
  cutHeight?: number | null;
  /** Kept under the elevation; default null: nothing below is cut away. */
  below?: number | null;
}

/** The z range a level cut keeps: null for an open end. */
export function levelCutRange(cut: LevelCut): { min: number | null; max: number | null } {
  const top = cut.cutHeight === undefined ? PLAN_CUT_HEIGHT : cut.cutHeight;
  const below = cut.below ?? null;
  return {
    min: below === null ? null : cut.elevation - below - LEVEL_TOLERANCE,
    max: top === null ? null : cut.elevation + top,
  };
}

/**
 * The clip planes of a level cut, as three.js keeps them: points with `normal . p + constant >= 0`
 * stay. Zero, one or two planes.
 */
export function levelCutPlanes(
  cut: LevelCut | null,
): { normal: [number, number, number]; constant: number }[] {
  if (!cut) return [];
  const { min, max } = levelCutRange(cut);
  const out: { normal: [number, number, number]; constant: number }[] = [];
  if (min !== null) out.push({ normal: [0, 0, 1], constant: -min });
  if (max !== null) out.push({ normal: [0, 0, -1], constant: max });
  return out;
}

// Layers ------------------------------------------------------------------------------------

/**
 * The wall layer a body is, from its id: a wall's translator names its layer bodies
 * `<feature id>:layer/<layer id>` (ADR 0015 decision 3), shown as `<part id>/<that>`.
 */
export function bodyLayer(bodyId: string): string | null {
  const m = /:layer\/([^/]+)$/.exec(bodyId);
  return m ? m[1]! : null;
}

// LOD ---------------------------------------------------------------------------------------

/**
 * The one LOD rule (T6.5a recommendation 6): instancing makes members cheap to draw, and hiding
 * small members or merging far groups saved nothing measurable, but member edges are a quarter
 * of the frame. A group's edges are drawn only while its thinnest stock spans this many pixels.
 */
export const MEMBER_EDGE_MIN_PX = 3;

export function memberEdgesVisible(thinnest: number, worldPerPixel: number): boolean {
  return worldPerPixel > 0 && thinnest / worldPerPixel >= MEMBER_EDGE_MIN_PX;
}

// The info panel ----------------------------------------------------------------------------

/** A cut as the info panel lists it: what kind it is and its angle off square, in radians. */
export interface CutSummary {
  kind: 'end' | 'face' | 'notch';
  /** For an end cut: between the cut and a square cut. */
  angle?: number;
}

/**
 * Describe a cut from the member's own frame (x along the member): a plane whose normal runs
 * mostly along x is an end cut (plumb, bevel, side cut), its angle off square the normal's angle
 * from x; otherwise it trims a face (a seat, a rip); a notch is a birdsmouth.
 */
export function describeCut(cut: MemberCut): CutSummary {
  if (cut.kind === 'notch') return { kind: 'notch' };
  const along = Math.abs(cut.n[0]);
  if (along < Math.SQRT1_2) return { kind: 'face' };
  return { kind: 'end', angle: Math.acos(Math.min(1, along)) };
}
