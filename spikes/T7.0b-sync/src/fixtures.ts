// Start documents: the M1 bracket (core's v15 golden), and a part of 200 features grown from it
// by the generator (sketches, extrudes, fillets, chamfers, shells, holes, patterns, mirrors).

import { applyCommand, deserialize, type ManufaktureDocument } from '@manufakture/core';
import bracketJson from '../../../packages/core/src/fixtures/v15-bracket.json';
import { Generator } from './generator.ts';
import { Rng } from './rng.ts';

export function bracket(): ManufaktureDocument {
  const r = deserialize(JSON.stringify(bracketJson));
  if (!r.ok) throw new Error(`bracket fixture: ${r.error.message}`);
  return r.value.document;
}

const FEATURES_ONLY = {
  sketch: 10,
  extrude: 10,
  fillet: 5,
  chamfer: 4,
  shell: 1,
  hole: 2,
  pattern: 2,
  mirror: 2,
  editExtrude: 0,
  editSketch: 0,
  editFillet: 0,
  delete: 0,
  reorder: 0,
  suppress: 0,
  rollback: 0,
  setVariable: 0,
  deleteVariable: 0,
  batch: 0,
  replaceDocument: 0,
  addPart: 0,
  duplicatePart: 0,
  addAssembly: 0,
  addInstance: 0,
  addMate: 0,
  configParameter: 0,
  configRow: 0,
  camTool: 0,
  camSetup: 0,
  camOperation: 0,
};

/** The bracket grown to `count` features in part#1, deterministically. */
export function bigPart(count = 200): ManufaktureDocument {
  let doc = bracket();
  const gen = new Generator(new Rng(4242), 9, { weights: FEATURES_ONLY });
  while (doc.parts[0]!.features.length < count) {
    const g = gen.generate({ ...doc, parts: [doc.parts[0]!] });
    if (!g) throw new Error('bigPart: the generator gave up');
    const r = applyCommand(doc, g.command);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}
