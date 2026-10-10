// A construction model as `@manufakture/io`'s IFC writer takes it (T6.6a): the walls, openings,
// floors and roofs of a part studio from the metadata their translators returned in the last
// regen, the framing members from its member sets, and the document's levels. Pure data mapping;
// the writer (and web-ifc) run wherever the caller exports (the regen worker in the app).
//
// - A wall is its `WallMetadata` with its framing layer and the sheet layers that have bodies.
// - An opening is its `OpeningMetadata`, on its host wall when that wall is in the model.
// - A floor is its subfloor slab: the floor's outline, its top, the subfloor stock's thickness
//   (no body when the floor has no subfloor).
// - A roof is its kind and its sheathing, one sheet per plane, on the rafters' top plane exactly
//   as the roof translator builds the sheathing bodies (`features/roof.ts`).
// - Members whose owner is not in the model (a feature that failed this regen) are left out and
//   named in `notes`; the writer refuses members of unknown owners.
// - What a remodel takes out (#1213, phase `demolish`) is left out, named in `notes`: a demolished
//   wall, opening, floor or roof, and an opening on a demolished wall. Demolished members are not
//   in the member sets' members, so they never reach the file.

import type {
  IfcBuildingInput,
  IfcFloorInput,
  IfcLengthUnit,
  IfcMemberInput,
  IfcOpeningInput,
  IfcRoofInput,
  IfcSheetInput,
  IfcVec3,
  IfcWallInput,
} from '@manufakture/io';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { metadataPhase, readOpeningMetadata, readWallMetadata } from '../features/common';
import { readFloorMetadata } from '../features/floor';
import { readRoofMetadata, sheathingOutlines, type RoofMetadata } from '../features/roof';
import { resolveRoofSettings } from '../framing/roof';
import type { Level } from '../levels';

/** A feature result as regen reports it (`FeatureResult` satisfies this). */
export interface ConstructionIfcFeature {
  readonly featureId: string;
  /** Regen's status; anything but `ok` is left out. Absent: taken as built. */
  readonly status?: string;
  /** What the feature's translator returned. */
  readonly metadata?: unknown;
}

export interface ConstructionIfcSource {
  /** The document's id: the file's GlobalIds derive from it. */
  readonly documentId: string;
  /** The document's name. */
  readonly name: string;
  /** The file's length unit; an `ft-in` document passes `ft`. */
  readonly unit: IfcLengthUnit;
  /** The document's levels, evaluated (mm). */
  readonly levels: readonly Level[];
  /** The part studio's feature results. */
  readonly features: readonly ConstructionIfcFeature[];
  /** The part studio's construction members (every member set's, flattened). */
  readonly members: readonly IfcMemberInput[];
  /** Feature names to write, by feature id; the id when absent. */
  readonly names?: ReadonlyMap<string, string>;
}

export interface ConstructionIfc {
  building: IfcBuildingInput;
  /** What was left out, for people. */
  notes: string[];
}

type P2 = readonly [number, number];

/** The roof's sheathing sheets, one per plane, where `translateRoof` builds their bodies. */
export function roofSheets(meta: RoofMetadata): IfcSheetInput[] {
  if (meta.sheathing === null) return [];
  const { input } = meta;
  const st = resolveRoofSettings(input.settings);
  const { origin, length: L, width: W, plate, wallThickness } = input.footprint;
  const direction = input.footprint.direction ?? 0;
  const cos = Math.cos(input.pitch);
  const sin = Math.sin(input.pitch);
  const tan = Math.tan(input.pitch);
  const U: P2 = [Math.cos(direction), Math.sin(direction)];
  const V: P2 = [-U[1], U[0]];
  const world = (u: number, w: number): P2 => [
    origin[0] + U[0] * u + V[0] * w,
    origin[1] + U[1] * u + V[1] * w,
  ];
  const frames: Record<1 | 2 | 3 | 4, { c: P2; t: P2 }> = {
    1: { c: world(0, 0), t: U },
    2: { c: world(L, 0), t: V },
    3: { c: world(L, W), t: [-U[0], -U[1]] },
    4: { c: world(0, W), t: [-V[0], -V[1]] },
  };
  // The rafters' top edge at the wall line, plumb above the plates.
  const hap = st.rafterStock.depth / cos - wallThickness * tan;
  return sheathingOutlines(input.kind, L, W, st.overhang, st.rakeOverhang).map((plane) => {
    const { c, t } = frames[plane.edge];
    const r: P2 = [-t[1], t[0]];
    // x along the edge, y up the slope (normal x x), z the plane's normal: the extrusion.
    const x: IfcVec3 = [t[0], t[1], 0];
    const y: IfcVec3 = [r[0] * cos, r[1] * cos, sin];
    return {
      id: `sheathing-e${plane.edge}`,
      placement: { origin: [c[0], c[1], plate + hap], x, y },
      outline: plane.points.map(([tt, rr]): P2 => [tt, rr / cos]),
      thickness: meta.sheathing!.thickness,
    };
  });
}

/** The IFC writer's building for a construction part studio (see the file's header). */
export function constructionIfcBuilding(src: ConstructionIfcSource): ConstructionIfc {
  const notes: string[] = [];
  const name = (id: string) => src.names?.get(id) ?? id;
  const walls: IfcWallInput[] = [];
  const openings: IfcOpeningInput[] = [];
  const floors: IfcFloorInput[] = [];
  const roofs: IfcRoofInput[] = [];
  const demolished = new Set<string>();
  for (const f of src.features) {
    if (f.status !== undefined && f.status !== 'ok') continue;
    const id = f.featureId;
    // What the work takes out (#1213) is not in the building the file describes.
    if (metadataPhase(f.metadata) === 'demolish') {
      demolished.add(id);
      notes.push(`${name(id)} is left out: it is demolished.`);
      continue;
    }
    const wall = readWallMetadata(f.metadata);
    if (wall) {
      walls.push({
        id,
        name: name(id),
        level: wall.level,
        base: wall.base,
        height: wall.height,
        points: wall.points,
        closed: wall.closed,
        thickness: wall.thickness,
        layers: wall.layers
          .filter((l) => l.kind === 'framing' || l.body !== null)
          .map((l) => ({ id: l.id, kind: l.kind, t: l.t })),
      });
      continue;
    }
    const opening = readOpeningMetadata(f.metadata);
    if (opening) {
      openings.push({
        id,
        name: name(id),
        wall: opening.wall,
        type: opening.type,
        segment: opening.segment,
        position: opening.position,
        width: opening.width,
        height: opening.height,
        sill: opening.sill,
      });
      continue;
    }
    const floor = readFloorMetadata(f.metadata);
    if (floor) {
      const stock = floor.input.settings.subfloor;
      floors.push({
        id,
        name: name(id),
        level: floor.level,
        outline: floor.input.outline,
        top: floor.top,
        ...(floor.subfloor !== null && stock !== undefined ? { thickness: stock.width } : {}),
      });
      continue;
    }
    const roof = readRoofMetadata(f.metadata);
    if (roof) {
      const sheets = roofSheets(roof);
      roofs.push({
        id,
        name: name(id),
        level: roof.level,
        kind: roof.input.kind,
        ...(sheets.length > 0 ? { sheets } : {}),
      });
    }
  }
  const wallIds = new Set(walls.map((w) => w.id));
  const hosted = openings.filter((o) => {
    if (wallIds.has(o.wall)) return true;
    if (demolished.has(o.wall)) {
      notes.push(`Opening ${o.name} is left out: its wall is demolished.`);
      return false;
    }
    notes.push(`Opening ${o.name} is left out: its wall did not build.`);
    return false;
  });
  const owners = new Set([
    ...wallIds,
    ...hosted.map((o) => o.id),
    ...floors.map((f) => f.id),
    ...roofs.map((r) => r.id),
  ]);
  const members = src.members.filter((m) => owners.has(m.owner));
  const dropped = src.members.length - members.length;
  if (dropped > 0) {
    notes.push(
      `${dropped} member${dropped === 1 ? ' is' : 's are'} left out: their feature did not build.`,
    );
  }
  return {
    building: {
      documentId: src.documentId,
      name: src.name,
      unit: src.unit,
      disclaimer: DISCLAIMER_SHORT,
      levels: src.levels.map((l) => ({ id: l.id, name: l.name, elevation: l.elevation })),
      walls,
      openings: hosted,
      floors,
      roofs,
      members,
    },
    notes,
  };
}
