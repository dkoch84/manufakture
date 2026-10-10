// What the construction takeoff counts, from the regenerated model (M6 plan T6.3b; moved from the
// app's Takeoff panel in M8 plan T8.1b): the framing members regen sent for the part studio, and
// the sheet faces of its walls, floors and roofs, rebuilt from the metadata their translators
// returned (ADR 0013 decision 7: derived, never stored).
//
// Faces, as T6.3a's fixtures measure them:
// - **Walls**: one face per path segment and sheet layer with a body (siding, sheathing,
//   drywall), on the framing's face on that layer's side: the line the path's framing edge makes,
//   mitred at the path's own corners and square at its open ends. Openings cut it at their rough
//   size. A gable fill the roof carried up from that layer (`<roof>:layer/gable-e<n>-<layer>`)
//   tops the wall's face as a triangle, peaking at mid-length, when the wall is one segment; on a
//   wall of several segments it is a face of its own.
// - **Floors**: the subfloor, from the floor's outline, sheets across the joists.
// - **Roofs**: one face per plane of roof sheathing, from the roof's framing input.
//
// Every face's id is the layer body it stands for (with `/s<n>` for a wall segment past the first
// of several), so a row's sources name bodies the viewport can pick; `bodies` maps each face to
// the bodies it covers. A layer with no sheet stock (a thickness only) cannot be counted in
// sheets, and `notes` says so.
//
// Phases (#1213, `phases.ts`): members carry the phase their set's metadata gives them, and the
// demolished members go to `demolished`; a sheet face takes its feature's phase (a wall's,
// floor's or roof's; a gable fill its roof's), and those of demolished features go to
// `demolished` too. A wall's faces are cut by the openings that are there when the work is done
// (a demolished wall's: by those that were there as built). `phaseInput` makes the input of a new
// material or a demolition list. A model with no phases makes the input it made before them.

import type { ExtensionFeature, ManufaktureDocument } from '@manufakture/core';
import type { FeatureResult, MemberData } from '@manufakture/regen';
import type { StockData } from '@manufakture/stock';
import { CONSTRUCTION_NAMESPACE, type ConstructionSettings } from '../data';
import {
  metadataPhase,
  readOpeningMetadata,
  readWallMetadata,
  type OpeningMetadata,
  type WallMetadata,
} from '../features/common';
import type { Phase } from '../members';
import { setPhases } from '../phases';
import { readFloorMetadata } from '../features/floor';
import { readRoofMetadata, type RoofMetadata } from '../features/roof';
import { roofSheathingFaces, subfloorFace, wallFace, type FaceOpening } from './faces';
import type {
  ConstructionTakeoffInput,
  ConstructionTakeoffSettings,
  SheetFace,
  SheetLayerKind,
  TakeoffMember,
} from './types';

type P2 = readonly [number, number];

/** The takeoff's input and what the panel needs besides. */
export interface TakeoffModel {
  input: ConstructionTakeoffInput;
  /** The layer bodies each face covers, by face id. */
  bodies: ReadonlyMap<string, readonly string[]>;
  /** Member full ids, for picking a row's members. */
  members: ReadonlySet<string>;
  /** Things the takeoff could not count, for people. */
  notes: string[];
}

const EPS = 1e-6;

/** Corners of offset lines: where line `a + n o + s d` meets the next one. */
function meet(a: P2, d: P2, b: P2, e: P2): P2 | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < EPS) return null;
  const t = ((b[0] - a[0]) * e[1] - (b[1] - a[1]) * e[0]) / den;
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}

interface Segment {
  a: P2;
  d: P2;
  n: P2;
  length: number;
}

function segmentsOf(meta: WallMetadata): Segment[] {
  const pts = meta.points;
  const count = meta.closed ? pts.length : pts.length - 1;
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(length > EPS)) continue;
    const d: P2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    out.push({ a, d, n: [-d[1], d[0]], length });
  }
  return out;
}

/**
 * Each segment's face on the line `offset` from the path (positive to its left): where it starts
 * and ends along the segment's direction, from the segment's first point.
 */
export function faceSpans(
  meta: WallMetadata,
  offset: number,
): { segment: number; start: number; end: number }[] {
  const segs = segmentsOf(meta);
  const on = (s: Segment): P2 => [s.a[0] + s.n[0] * offset, s.a[1] + s.n[1] * offset];
  const along = (s: Segment, p: P2) => (p[0] - s.a[0]) * s.d[0] + (p[1] - s.a[1]) * s.d[1];
  return segs.map((s, i) => {
    const prev = i > 0 ? segs[i - 1] : meta.closed ? segs[segs.length - 1] : undefined;
    const next = i + 1 < segs.length ? segs[i + 1] : meta.closed ? segs[0] : undefined;
    const startPoint = prev && prev !== s ? meet(on(prev), prev.d, on(s), s.d) : null;
    const endPoint = next && next !== s ? meet(on(s), s.d, on(next), next.d) : null;
    return {
      segment: i + 1,
      start: startPoint ? along(s, startPoint) : 0,
      end: endPoint ? along(s, endPoint) : s.length,
    };
  });
}

const SHEET_KINDS: Readonly<Record<string, SheetLayerKind>> = {
  siding: 'siding',
  sheathing: 'sheathing',
  drywall: 'drywall',
};

/** A gable fill the roof carried up from a wall's sheet layer. */
interface Gable {
  body: string;
  pitch: number;
  width: number;
  roof: string;
}

function wallFaces(
  wallId: string,
  meta: WallMetadata,
  stockOf: (layerId: string) => string | undefined,
  openings: readonly OpeningMetadata[],
  gables: ReadonlyMap<string, readonly Gable[]>,
  out: { faces: SheetFace[]; bodies: Map<string, string[]>; notes: string[] },
): void {
  const framing = meta.layers.find((l) => l.kind === 'framing');
  if (framing === undefined) return;
  for (const layer of meta.layers) {
    const kind = SHEET_KINDS[layer.kind];
    if (kind === undefined || layer.body === null) continue;
    const stock = stockOf(layer.id);
    if (stock === undefined) {
      out.notes.push(
        `The ${layer.kind} layer "${layer.id}" of ${wallId} has a thickness but no sheet stock, so its sheets are not counted.`,
      );
      continue;
    }
    // The framing's face on the layer's side: its exterior edge for layers outside it.
    const outside = layer.t[1] <= framing.t[0] + EPS;
    const spans = faceSpans(meta, outside ? framing.t[0] : framing.t[1]);
    // A closed wall can carry both gable ends of a roof on one layer.
    const fills = gables.get(`${wallId}|${layer.id}`) ?? [];
    const gable = fills.length === 1 ? fills[0] : undefined;
    for (const span of spans) {
      const length = span.end - span.start;
      if (!(length > EPS)) continue;
      const id = spans.length === 1 ? layer.body : `${layer.body}/s${span.segment}`;
      const holes: FaceOpening[] = openings
        .filter((o) => o.segment === span.segment)
        .map((o) => ({
          position: o.position - span.start,
          width: o.width,
          height: o.height,
          sill: o.sill,
        }));
      const onWall = gable !== undefined && spans.length === 1;
      out.faces.push(
        wallFace({
          id,
          owner: wallId,
          layer: kind,
          stock,
          length,
          height: meta.height,
          openings: holes,
          ...(onWall ? { gableRise: (length / 2) * Math.tan(gable.pitch) } : {}),
        }),
      );
      out.bodies.set(id, onWall ? [layer.body, gable.body] : [layer.body]);
    }
    if (spans.length === 1 && fills.length < 2) continue;
    for (const fill of fills) {
      const rise = (fill.width / 2) * Math.tan(fill.pitch);
      out.faces.push({
        id: fill.body,
        owner: fill.roof,
        layer: kind,
        stock,
        width: fill.width,
        height: rise,
        outline: [
          [0, 0],
          [fill.width, 0],
          [fill.width / 2, rise],
        ],
      });
      out.bodies.set(fill.body, [fill.body]);
    }
  }
}

function roofFaces(
  meta: RoofMetadata,
  out: { faces: SheetFace[]; bodies: Map<string, string[]> },
): void {
  if (meta.sheathing === null) return;
  const bodies = meta.sheathing.bodies;
  for (const face of roofSheathingFaces(meta.input, meta.sheathing.stock)) {
    // `<roof>:sheathing:e<n>` to the body `<roof>:layer/sheathing-e<n>`.
    const edge = face.id.slice(face.id.lastIndexOf(':e') + 2);
    const body = bodies.find((b) => b.endsWith(`sheathing-e${edge}`)) ?? face.id;
    out.faces.push({ ...face, id: body });
    out.bodies.set(body, [body]);
  }
}

const isConstruction = (f: FeatureResult, doc: ExtensionFeature | undefined) =>
  f.kind === 'extension' && f.status === 'ok' && doc !== undefined;

/**
 * A framing group's members as the takeoff reads them: the app's view of a set fits, and so does
 * regen's `MemberSetResult` once its `members` are known (a regen leaves them null for a set that
 * did not change since the last one; a first regen on a fresh engine sends every set).
 */
export interface TakeoffMemberSet {
  /** The domain that framed it. */
  namespace: string;
  members: readonly MemberData[];
  /** What the member stage returned beside the members: the phases (#1213) are read from it. */
  metadata?: unknown;
}

export interface TakeoffSources {
  document: ManufaktureDocument;
  partId: string;
  /** The part studio's feature results (with their metadata). */
  features: readonly FeatureResult[];
  /** The part studio's member sets. */
  sets: readonly TakeoffMemberSet[];
  settings: ConstructionSettings | undefined;
  stock: StockData | undefined;
}

/** The takeoff's settings from the document's (`domains.construction.takeoff`). */
export function takeoffSettings(settings: ConstructionSettings | undefined) {
  const t = settings?.takeoff;
  const out: ConstructionTakeoffSettings = {
    ...(t?.precuts === undefined ? {} : { precuts: t.precuts }),
    ...(t?.wastePercent === undefined ? {} : { wastePercent: t.wastePercent }),
    ...(t?.currency === undefined ? {} : { currency: t.currency }),
    ...(t?.lengths === undefined ? {} : { lengths: t.lengths }),
  };
  return out;
}

/** The takeoff's input for a part studio of the shown model. */
export function takeoffModel(src: TakeoffSources): TakeoffModel {
  const part = src.document.parts.find((p) => p.id === src.partId);
  const featureOf = new Map<string, ExtensionFeature>();
  for (const f of part?.features ?? []) {
    if (f.kind === 'extension') featureOf.set(f.id, f);
  }
  const walls = new Map<string, WallMetadata>();
  const openings = new Map<string, OpeningMetadata[]>();
  const levels: Record<string, string> = {};
  const gables = new Map<string, Gable[]>();
  const out = {
    faces: [] as SheetFace[],
    bodies: new Map<string, string[]>(),
    notes: [] as string[],
  };
  const roofs: RoofMetadata[] = [];
  const hosts: [string, string][] = [];
  const phaseOf = new Map<string, Phase>();
  for (const f of src.features) {
    if (!isConstruction(f, featureOf.get(f.featureId))) continue;
    phaseOf.set(f.featureId, metadataPhase(f.metadata));
    const wall = readWallMetadata(f.metadata);
    if (wall) {
      walls.set(f.featureId, wall);
      levels[f.featureId] = wall.level;
      continue;
    }
    const opening = readOpeningMetadata(f.metadata);
    if (opening) {
      const list = openings.get(opening.wall) ?? [];
      list.push(opening);
      openings.set(opening.wall, list);
      hosts.push([f.featureId, opening.wall]);
      continue;
    }
    const floor = readFloorMetadata(f.metadata);
    if (floor) {
      levels[f.featureId] = floor.level;
      const stock = floor.input.settings.subfloor;
      if (floor.subfloor !== null && stock !== undefined) {
        const face = subfloorFace(
          f.featureId,
          { stock, outline: [...floor.input.outline], area: 0, z: [0, 0] },
          floor.input.direction,
          { id: floor.subfloor },
        );
        out.faces.push(face);
        out.bodies.set(face.id, [floor.subfloor]);
      }
      continue;
    }
    const roof = readRoofMetadata(f.metadata);
    if (roof) {
      levels[f.featureId] = roof.level;
      roofs.push(roof);
      for (const g of roof.gables) {
        // `<roof>:layer/gable-e<n>-<layer id>`: the wall's layer it carries up.
        const prefix = `gable-e${g.edge}-`;
        const at = g.body.lastIndexOf(prefix);
        if (at < 0) continue;
        const key = `${g.wall}|${g.body.slice(at + prefix.length)}`;
        gables.set(key, [
          ...(gables.get(key) ?? []),
          {
            body: g.body,
            pitch: roof.input.pitch,
            width: roof.input.footprint.width,
            roof: f.featureId,
          },
        ]);
      }
    }
  }
  // Openings are on their wall's level.
  for (const [openingId, wallId] of hosts) {
    const level = levels[wallId];
    if (level !== undefined) levels[openingId] = level;
  }
  const wallTypes = new Map((src.settings?.wallTypes ?? []).map((t) => [t.id, t]));
  for (const [wallId, meta] of walls) {
    const params = featureOf.get(wallId)?.params as { wallType?: unknown } | undefined;
    const type = typeof params?.wallType === 'string' ? wallTypes.get(params.wallType) : undefined;
    const stockOf = (layerId: string) => {
      const layer = type?.layers.find((l) => l.id === layerId);
      return layer && layer.kind !== 'framing' ? layer.stock : undefined;
    };
    // The openings there when the work is done; a demolished wall's, those there as built.
    const gone: Phase = meta.phase === 'demolish' ? 'new' : 'demolish';
    const holes = (openings.get(wallId) ?? []).filter((o) => metadataPhase(o) !== gone);
    wallFaces(wallId, meta, stockOf, holes, gables, out);
  }
  for (const meta of roofs) roofFaces(meta, out);

  const members: TakeoffMember[] = [];
  const demolishedMembers: TakeoffMember[] = [];
  const ids = new Set<string>();
  let phased = [...phaseOf.values()].some((p) => p !== 'new');
  for (const set of src.sets) {
    if (set.namespace !== CONSTRUCTION_NAMESPACE) continue;
    const phases = setPhases(set.metadata);
    phased ||= phases.phased;
    for (const m of set.members) {
      const full = `${m.owner}:${m.id}`;
      members.push(
        phases.phased
          ? { ...(m as TakeoffMember), phase: phases.phaseOf(full) }
          : (m as TakeoffMember),
      );
      ids.add(full);
    }
    for (const m of phases.demolished) demolishedMembers.push({ ...m, phase: 'demolish' });
  }
  // Faces by their feature's phase: a gable fill is its roof's.
  const faces: SheetFace[] = [];
  const demolishedFaces: SheetFace[] = [];
  for (const face of out.faces) {
    const phase = phaseOf.get(face.owner) ?? 'new';
    if (phase === 'demolish') demolishedFaces.push({ ...face, phase });
    else faces.push(phased ? { ...face, phase } : face);
  }
  return {
    input: {
      members,
      faces,
      ...(phased ? { demolished: { members: demolishedMembers, faces: demolishedFaces } } : {}),
      levels,
      ...(src.stock === undefined ? {} : { stock: src.stock }),
      settings: takeoffSettings(src.settings),
    },
    bodies: out.bodies,
    members: ids,
    notes: out.notes,
  };
}

/**
 * The takeoff input of one phase (#1213): `new` (new material: what the work adds) or `existing`
 * (what stays as built), from the design's members and faces; `demolish` (the demolition list),
 * from what the design takes out. A member or face with no phase is new.
 */
export function phaseInput(
  input: ConstructionTakeoffInput,
  phase: Phase,
): ConstructionTakeoffInput {
  const rest = { ...input };
  delete (rest as { demolished?: unknown }).demolished;
  if (phase === 'demolish') {
    return {
      ...rest,
      members: input.demolished?.members ?? [],
      faces: input.demolished?.faces ?? [],
    };
  }
  const of = (x: { phase?: Phase }) => (x.phase ?? 'new') === phase;
  return {
    ...rest,
    members: input.members.filter(of),
    faces: (input.faces ?? []).filter(of),
  };
}

/** Whether a takeoff input has phases (a feature with one, or a set the member stage phased). */
export const hasPhases = (input: ConstructionTakeoffInput): boolean =>
  input.demolished !== undefined;
