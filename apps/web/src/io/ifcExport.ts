// IFC export of a construction part studio (T6.6a): the walls, openings, floors and roofs of the
// last regen and the member sets the app holds, mapped by the construction domain
// (`constructionIfcBuilding`) and written in the regen worker, where web-ifc loads on the first
// export. The app loads this module only when the user asks for IFC, so neither the mapping nor
// anything of web-ifc is in the main bundle.

import type { ManufaktureDocument } from '@manufakture/core';
import { constructionIfcBuilding } from '@manufakture/domain-construction';
import { fileName, type IfcBuildingInput, type IfcLengthUnit } from '@manufakture/io';
import type { FeatureResult } from '@manufakture/regen';
import { documentConstruction } from '../construction/settings';
import { CONSTRUCTION_DOMAIN } from '../construction/kinds';
import type { MemberSetView } from '../viewport/members';
import type { ActionResult, ExportedFile } from './actions';

/** Writes a building as IFC: the regen worker in the app. */
export interface IfcExporter {
  exportIfc(building: IfcBuildingInput): Promise<Uint8Array>;
}

export interface IfcExportSources {
  document: ManufaktureDocument;
  partId: string;
  /** The part studio's feature results of the last regen (with their metadata). */
  features: readonly FeatureResult[];
  /** The part studio's member sets. */
  sets: readonly MemberSetView[];
}

export const IFC_TYPE = 'application/x-step';

/** The file's length unit for the document's display unit: feet for feet and inches. */
export function ifcUnit(doc: ManufaktureDocument): IfcLengthUnit {
  const unit = doc.units.length.unit;
  return unit === 'ft-in' ? 'ft' : unit === 'in-fraction' ? 'in' : unit;
}

/** The writer's input for a part studio, and what the mapping left out. */
export function ifcBuilding(src: IfcExportSources): ActionResult<IfcBuildingInput> {
  const data = documentConstruction(src.document);
  if (!data.ok) return { ok: false, message: data.message };
  const levels = data.data?.settings.levels ?? [];
  if (levels.length === 0) {
    return { ok: false, message: 'IFC export needs a construction document with a level.' };
  }
  const part = src.document.parts.find((p) => p.id === src.partId);
  const names = new Map((part?.features ?? []).map((f) => [f.id, f.name]));
  const members = src.sets
    .filter((s) => s.namespace === CONSTRUCTION_DOMAIN)
    .flatMap((s) => s.members);
  const { building, notes } = constructionIfcBuilding({
    documentId: src.document.id,
    name: src.document.name,
    unit: ifcUnit(src.document),
    levels,
    features: src.features,
    members,
    names,
  });
  if (
    (building.walls?.length ?? 0) +
      (building.floors?.length ?? 0) +
      (building.roofs?.length ?? 0) ===
    0
  ) {
    return { ok: false, message: 'There is no wall, floor or roof to export as IFC.' };
  }
  return { ok: true, value: building, message: notes.join(' ') };
}

/** The part studio as one IFC file, written by `exporter`. */
export async function exportIfc(
  exporter: IfcExporter,
  src: IfcExportSources,
): Promise<ActionResult<ExportedFile[]>> {
  const built = ifcBuilding(src);
  if (!built.ok) return built;
  try {
    const bytes = await exporter.exportIfc(built.value);
    const name = fileName(src.document.name, 'ifc');
    return {
      ok: true,
      value: [{ name, bytes, type: IFC_TYPE }],
      message: [`Exported ${name}.`, built.message].filter((s) => s !== '').join(' '),
    };
  } catch (e) {
    return {
      ok: false,
      message: `IFC export failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
