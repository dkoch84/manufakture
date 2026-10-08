// The document's construction settings (`domains.construction`, ADR 0015 decision 2) as the
// construction panels edit them: levels and wall types. Settings, not model (ADR 0013 decision 3):
// every length is a constant, stock is named by catalog id. Each edit is one `setDomainData`
// (with the walls it affects, in one batch), so one undo step; the domain's own reader checks
// every edit before it is offered, so the panels refuse exactly what regen would.
//
// New documents get one level and nothing else: no wall types and no header rules (ADR 0015
// decision 7, the project owner's decision). A wall type asks for its default header when it is
// made (`newWallType` requires it).

import type {
  Command,
  DisplayUnits,
  ExtensionFeature,
  ManufaktureDocument,
  StoredExpression,
} from '@manufakture/core';
import {
  CONSTRUCTION_NAMESPACE,
  DATA_ID_PATTERN,
  LAYER_KINDS,
  MAX_LAYERS,
  MAX_LEVELS,
  MAX_TYPES,
  defaultConstructionSettings,
  documentConstruction,
  openingScope,
  writeConstructionData,
  type HeaderData,
  type LayerKind,
  type StoredConstructionSettings,
  type StoredLevel,
  type WallLayer,
  type WallType,
} from '@manufakture/domain-construction';
import { evaluate } from '@manufakture/units';
import { documentRegion } from '../wood/catalog';
import { isOpening, isWall, omit } from './kinds';
import { coordinateExpression } from './lengths';

export type Outcome<T = Command | null> =
  { ok: true; command: T; label: string } | { ok: false; message: string };

export type StoredWallType = WallType<StoredExpression>;

// The document's construction data, read (undefined when it has none): the domain's reader.
export { documentConstruction };

export { hasConstruction, isOpening, isWall } from './kinds';

/**
 * The command that stores `next` as the document's construction settings, checked by the
 * domain's reader; `extra` commands (walls the edit affects) go in the same batch. Null when
 * nothing changes.
 */
export function settingsCommand(
  doc: ManufaktureDocument,
  next: StoredConstructionSettings,
  label: string,
  extra: readonly Command[] = [],
): Outcome {
  const written = writeConstructionData(next);
  if (!written.ok) return { ok: false, message: written.message };
  const entry = doc.domains?.[CONSTRUCTION_NAMESPACE];
  const before = entry ? { schemaVersion: entry.schemaVersion, data: entry.data } : null;
  const same = JSON.stringify(written.value ?? null) === JSON.stringify(before);
  if (same && extra.length === 0) return { ok: true, command: null, label };
  const set: Command =
    written.value === undefined
      ? { type: 'setDomainData', namespace: CONSTRUCTION_NAMESPACE }
      : {
          type: 'setDomainData',
          namespace: CONSTRUCTION_NAMESPACE,
          schemaVersion: written.value.schemaVersion,
          data: written.value.data as never,
        };
  const commands = same ? [...extra] : [set, ...extra];
  return {
    ok: true,
    command: commands.length === 1 ? commands[0]! : { type: 'batch', commands },
    label,
  };
}

/** The stored settings to edit: the document's, else what a new document starts with. */
export function storedOrDefault(
  doc: ManufaktureDocument,
): { ok: true; stored: StoredConstructionSettings } | { ok: false; message: string } {
  const r = documentConstruction(doc);
  if (!r.ok) {
    return { ok: false, message: `The construction settings cannot be read: ${r.message}` };
  }
  return { ok: true, stored: r.data?.stored ?? startingSettings(doc.units) };
}

/** What a document starts with: one level at the datum, for the region its units suggest. */
export function startingSettings(units: DisplayUnits): StoredConstructionSettings {
  return defaultConstructionSettings(documentRegion(units));
}

/** Start the construction settings (one level, no wall types, no header rules). */
export function startCommand(doc: ManufaktureDocument): Outcome {
  if (doc.domains?.[CONSTRUCTION_NAMESPACE] !== undefined) {
    return { ok: true, command: null, label: 'Start construction' };
  }
  return settingsCommand(doc, startingSettings(doc.units), 'Start construction');
}

// Levels -------------------------------------------------------------------------------------

/** A fresh id `<prefix>-<n>` not in `taken`. */
export function freshId(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; n <= taken.size + 1; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.has(id)) return id;
  }
  return `${prefix}-${taken.size + 2}`;
}

const lengthOf = (e: StoredExpression): number => {
  const r = evaluate(e.source, {
    expected: 'length',
    lengthUnit: e.lengthUnit,
    angleUnit: e.angleUnit,
  });
  return r.ok ? r.value : 0;
};

/** Add a level on top of the highest one, as high as it. */
export function addLevel(doc: ManufaktureDocument): Outcome {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  const levels = s.stored.levels;
  if (levels.length >= MAX_LEVELS) {
    return { ok: false, message: `A document has at most ${MAX_LEVELS} levels.` };
  }
  const id = freshId('level', new Set(levels.map((l) => l.id)));
  const top = levels.reduce<StoredLevel | undefined>(
    (best, l) =>
      best === undefined || lengthOf(l.elevation) > lengthOf(best.elevation) ? l : best,
    undefined,
  );
  const elevation = top
    ? coordinateExpression(lengthOf(top.elevation) + lengthOf(top.height), doc.units)
    : coordinateExpression(0, doc.units);
  const height = top?.height ?? startingSettings(doc.units).levels[0]!.height;
  const level: StoredLevel = { id, name: `Level ${levels.length + 1}`, elevation, height };
  return settingsCommand(doc, { ...s.stored, levels: [...levels, level] }, `Add ${level.name}`);
}

export type LevelEdit =
  { field: 'name'; value: string } | { field: 'elevation' | 'height'; value: StoredExpression };

/** Rename a level, or set its elevation or default wall height (constants). */
export function editLevel(doc: ManufaktureDocument, id: string, edit: LevelEdit): Outcome {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  const level = s.stored.levels.find((l) => l.id === id);
  if (!level) return { ok: false, message: 'That level is gone.' };
  if (edit.field === 'name') {
    const name = edit.value.trim();
    if (name === '' || name.length > 200) {
      return { ok: false, message: 'A level name has 1 to 200 characters.' };
    }
  }
  const value = edit.field === 'name' ? edit.value.trim() : edit.value;
  const next = { ...level, [edit.field]: value };
  const label =
    edit.field === 'name' ? `Rename ${level.name}` : `Set the ${edit.field} of ${level.name}`;
  return settingsCommand(
    doc,
    { ...s.stored, levels: s.stored.levels.map((l) => (l.id === id ? next : l)) },
    label,
  );
}

// Wall types ------------------------------------------------------------------------------------

/** What the New wall type form fills in; the default header is required. */
export interface WallTypeInput {
  name: string;
  studStock: string;
  sheathing: string | null;
  drywall: string | null;
  header: HeaderData;
}

/** An id for a new wall type from its name (`Exterior 2x4` to `exterior-2x4`), unique. */
export function wallTypeId(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .slice(0, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  if (slug !== '' && DATA_ID_PATTERN.test(slug) && !taken.has(slug)) return slug;
  return freshId(slug !== '' && DATA_ID_PATTERN.test(slug) ? slug : 'wall-type', taken);
}

export function addWallType(
  doc: ManufaktureDocument,
  input: WallTypeInput,
): Outcome<Command> & {
  id?: string;
} {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  if (s.stored.wallTypes.length >= MAX_TYPES) {
    return { ok: false, message: `A document has at most ${MAX_TYPES} wall types.` };
  }
  const name = input.name.trim();
  if (name === '' || name.length > 200) {
    return { ok: false, message: 'A wall type name has 1 to 200 characters.' };
  }
  const id = wallTypeId(name, new Set(s.stored.wallTypes.map((t) => t.id)));
  const type = newWallTypeOf(id, name, input);
  const r = settingsCommand(
    doc,
    { ...s.stored, wallTypes: [...s.stored.wallTypes, type] },
    `Add the ${name} wall type`,
  );
  if (!r.ok) return r;
  if (r.command === null) return { ok: false, message: 'Nothing to add.' };
  return { ok: true, command: r.command, label: r.label, id };
}

function newWallTypeOf(id: string, name: string, input: WallTypeInput): StoredWallType {
  const layers: WallLayer<StoredExpression>[] = [];
  if (input.sheathing !== null)
    layers.push({ id: 'sheathing', kind: 'sheathing', stock: input.sheathing });
  layers.push({ id: 'framing', kind: 'framing', stock: input.studStock, header: input.header });
  if (input.drywall !== null) layers.push({ id: 'drywall', kind: 'drywall', stock: input.drywall });
  return { id, name, layers };
}

/** Whether a wall type makes layer bodies: it has a siding, sheathing or drywall layer. */
export function makesBodies(type: { layers: readonly { kind: LayerKind }[] }): boolean {
  return type.layers.some((l) => l.kind !== 'framing');
}

/**
 * The edits that keep every wall of `type` building after its layers change: a wall makes its
 * layer bodies (operation `new`) exactly when its type has sheet layers, and each opening it hosts
 * keeps its `scope` on exactly those bodies (`openingScope`): a layer added or removed adds or
 * removes its body there.
 */
export function wallsFollowing(doc: ManufaktureDocument, type: StoredWallType): Command[] {
  const makes = makesBodies(type);
  const out: Command[] = [];
  for (const part of doc.parts) {
    const walls = new Map<string, ExtensionFeature>();
    for (const f of part.features) {
      if (!isWall(f) || f.params.wallType !== type.id) continue;
      const has = f.operation === 'new';
      const rest = omit(f, 'operation');
      const feature: ExtensionFeature = makes ? { ...rest, operation: 'new' } : rest;
      walls.set(f.id, feature);
      if (has !== makes) out.push({ type: 'editFeature', partId: part.id, feature });
    }
    for (const f of part.features) {
      if (!isOpening(f)) continue;
      const wall = walls.get(f.dependsOn[0] ?? '');
      if (wall === undefined) continue;
      const scope = openingScope(wall, type);
      if (JSON.stringify(f.scope) === JSON.stringify(scope)) continue;
      const rest = omit(f, 'scope');
      const feature: ExtensionFeature = scope === undefined ? rest : { ...rest, scope };
      out.push({ type: 'editFeature', partId: part.id, feature });
    }
  }
  return out;
}

/** Replace a wall type (as edited), with its walls kept building. */
export function editWallType(
  doc: ManufaktureDocument,
  next: StoredWallType,
  label: string,
): Outcome {
  const s = storedOrDefault(doc);
  if (!s.ok) return s;
  if (!s.stored.wallTypes.some((t) => t.id === next.id)) {
    return { ok: false, message: 'That wall type is gone.' };
  }
  return settingsCommand(
    doc,
    { ...s.stored, wallTypes: s.stored.wallTypes.map((t) => (t.id === next.id ? next : t)) },
    label,
    wallsFollowing(doc, next),
  );
}

/** A wall type with a sheet layer of `kind` added in its place (exterior to interior). */
export function withLayer(
  type: StoredWallType,
  kind: Exclude<LayerKind, 'framing'>,
  stock: string,
): StoredWallType | string {
  if (type.layers.length >= MAX_LAYERS) return `A wall type has at most ${MAX_LAYERS} layers.`;
  const id = freshLayerId(kind, new Set(type.layers.map((l) => l.id)));
  const rank = (k: LayerKind) => LAYER_KINDS.indexOf(k);
  const layers = [...type.layers];
  // Exterior to interior: after every layer of the same or an outer kind.
  let at = 0;
  for (let i = 0; i < layers.length; i++) if (rank(layers[i]!.kind) <= rank(kind)) at = i + 1;
  layers.splice(at, 0, { id, kind, stock });
  return { ...type, layers };
}

function freshLayerId(kind: string, taken: ReadonlySet<string>): string {
  return taken.has(kind) ? freshId(kind, taken) : kind;
}

export function withoutLayer(type: StoredWallType, layerId: string): StoredWallType {
  return { ...type, layers: type.layers.filter((l) => l.id !== layerId || l.kind === 'framing') };
}

/** A wall type with one layer replaced. */
export function withLayerChanged(
  type: StoredWallType,
  layerId: string,
  change: (layer: WallLayer<StoredExpression>) => WallLayer<StoredExpression>,
): StoredWallType {
  return { ...type, layers: type.layers.map((l) => (l.id === layerId ? change(l) : l)) };
}
