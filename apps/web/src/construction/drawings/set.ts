// "New construction set" (M6 plan T6.4b): the sheets of a building's drawing set, made in one
// command in the open drawing. The set itself is the construction domain's
// (`@manufakture/domain-construction`, `drawings/set.ts`), shared with the session's
// `addConstructionSet` helper so an agent makes the set this button makes; here it reads the
// document's variables as the app evaluates them (with the shown regen's measurements) and gives
// new sheets the drawing workspace's title block.

import type { Drawing, ManufaktureDocument, Sheet } from '@manufakture/core';
import {
  buildingOf as sharedBuildingOf,
  constructionSetCommand as sharedSetCommand,
  type SetCommand,
  type SetOptions,
} from '@manufakture/domain-construction';
import { TITLE_FIELDS } from '../../drawing/model';
import { evaluateVariables } from '../../sketcher/values';

export {
  IMPERIAL_SET_SCALES,
  MAX_SET_SHEETS,
  MAX_SET_VIEWS,
  METRIC_SET_SCALES,
  canMakeSet,
  fitScale,
  setScaleFactor,
  setScales,
  sheetRegion,
  type SetCommand,
  type SetOptions,
} from '@manufakture/domain-construction';

/** The part's walls and roofs, as stored, with their coordinates evaluated. */
export function buildingOf(doc: ManufaktureDocument, partId: string) {
  return sharedBuildingOf(doc, partId, evaluateVariables(doc));
}

/**
 * The command that adds a construction set's sheets to `drawing` (one undo step). The drawing's
 * only sheet, when it is still empty (a drawing just made), gives way to the set.
 */
export function constructionSetCommand(
  doc: ManufaktureDocument,
  drawing: Drawing,
  like: Sheet | undefined,
  options: SetOptions,
): ({ ok: true } & SetCommand) | { ok: false; message: string } {
  return sharedSetCommand(doc, drawing, like, options, {
    variables: evaluateVariables(doc),
    titleFields: TITLE_FIELDS,
  });
}
