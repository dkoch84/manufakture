// Documents for the construction tests: a feet-and-inches document, with construction started
// (one level, 97-1/8" walls) and an "Exterior 2x4" wall type (7/16" OSB outside, 2x4 studs, a
// default header of two 2x8 plies on one jack), and helpers to run the tools' commands.

import {
  applyCommand,
  createDocument,
  DEFAULT_UNITS,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import { addWallType, documentConstruction, startCommand } from './settings';

export const FT_IN: DisplayUnits = { ...DEFAULT_UNITS, length: { unit: 'ft-in', denominator: 16 } };
export const IN = 25.4;
export const FT = 12 * IN;
export const PART = 'part#1';

export function run(doc: ManufaktureDocument, command: Command | null): ManufaktureDocument {
  if (command === null) return doc;
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.document;
}

export const HEADER = { stock: 'us-2x8', plies: 2, jacks: 1 };

/** A feet-and-inches document with construction started and one wall type, `exterior-2x4`. */
export function constructionDocument(): ManufaktureDocument {
  let doc = createDocument({ id: 'shed', name: 'Shed', units: FT_IN });
  const start = startCommand(doc);
  if (!start.ok) throw new Error(start.message);
  doc = run(doc, start.command);
  const type = addWallType(doc, {
    name: 'Exterior 2x4',
    studStock: 'us-2x4',
    sheathing: 'us-osb-7-16',
    drywall: null,
    header: HEADER,
  });
  if (!type.ok) throw new Error(type.message);
  return run(doc, type.command);
}

export function settingsOf(doc: ManufaktureDocument) {
  const r = documentConstruction(doc);
  if (!r.ok || !r.data) throw new Error('no construction data');
  return r.data;
}
