// Documents for the Manufacture workspace's tests: the demo part (a filleted plate with a boss,
// two sketches) made of plywood, with a built-in tool copied in, and a setup built with the
// workspace's own commands.

import {
  applyCommand,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { BUILTIN_LIBRARY_ID, findBuiltinTool } from '@manufakture/cam/library';
import { demoDocument } from '../model/demo';
import { addSetupCommand } from './commands';
import { useToolInDocument as toolIntoDocument } from './library/use-in-document';

export const mm = (source: string): StoredExpression => ({
  source,
  lengthUnit: 'mm',
  angleUnit: 'deg',
});

export function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/** The demo part, in plywood. */
export function plywoodDocument(): ManufaktureDocument {
  return apply(demoDocument('doc'), { type: 'setMaterial', partId: 'part#1', material: 'plywood' });
}

/** Copy built-in tool `id` (`c3d-201`: a 1/4" flat end mill; `c3d-301`: a 90 degree V-bit). */
export function withTool(doc: ManufaktureDocument, id = 'c3d-201'): ManufaktureDocument {
  return apply(doc, toolIntoDocument(doc, findBuiltinTool(id)!, BUILTIN_LIBRARY_ID));
}

/** The plywood part with a 1/4" flat end mill and a setup of part#1 (`setup#1`). */
export function setupDocument(): ManufaktureDocument {
  const doc = withTool(plywoodDocument());
  return apply(doc, addSetupCommand(doc, 'part#1').command);
}
