// Test fixtures for the assembly workspace: a box and a lid as two part studios, an assembly
// with an instance of each (the box fixed), their regenerated bodies and a regen result.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { AssemblyResult, InstanceResult } from '@manufakture/regen';
import type { ModelBody, ModelState, PartModel } from '../model/model';
import type { BodyInput } from '../viewport/bodies';
import { boxBody } from '../viewport/testMeshes';
import { addAssemblyCommand, insertCommand } from './assembly';

export const A = 'assembly#1';
export const LIFTED = {
  translation: [0, 0, 20] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

export function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** Two part studios (a box, a lid) and an assembly with one instance of each, the box fixed. */
export function twoInstances(): ManufaktureDocument {
  let doc = createDocument({ id: 'd', name: 'D' });
  doc = apply(
    doc,
    { type: 'renamePart', partId: 'part#1', name: 'Box' },
    { type: 'addPart', partId: 'part#2', name: 'Lid' },
    addAssemblyCommand(doc).command,
  );
  const first = insertCommand(doc.assemblies[0]!, { part: 'part#1' }, 'Box');
  doc = apply(doc, first.command);
  return apply(doc, insertCommand(doc.assemblies[0]!, { part: 'part#2' }, 'Lid').command);
}

export const box = boxBody({ id: 'extrude#1', size: [40, 30, 20] });
export const lid = boxBody({ id: 'extrude#1', size: [40, 30, 5] });

export function modelBody(partId: string, view: BodyInput): ModelBody {
  return {
    bodyId: 'extrude#1',
    creator: 'extrude#1',
    solids: 1,
    view: { ...view, id: `${partId}/extrude#1` },
  };
}

export function instanceResult(
  id: string,
  part: string,
  extra: Partial<InstanceResult> = {},
): InstanceResult {
  return {
    instanceId: id,
    status: 'ok',
    source: { part },
    bodies: ['extrude#1'],
    transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
    moved: false,
    errors: [],
    warnings: [],
    ...extra,
  };
}

export function result(extra: Partial<AssemblyResult> = {}): AssemblyResult {
  return {
    assemblyId: A,
    outcome: 'solved',
    dof: 6,
    instances: [
      instanceResult('inst#1', 'part#1'),
      instanceResult('inst#2', 'part#2', { transform: LIFTED }),
    ],
    mates: [],
    redundant: [],
    conflicting: [],
    issues: [],
    warnings: [],
    ms: 0,
    ...extra,
  };
}

export function model(
  assemblies: AssemblyResult[] = [result()],
): Pick<ModelState, 'parts' | 'assemblies' | 'sources'> {
  const parts: PartModel[] = [
    { partId: 'part#1', features: [], bodies: [modelBody('part#1', box)] },
    { partId: 'part#2', features: [], bodies: [modelBody('part#2', lid)] },
  ];
  return { parts, assemblies, sources: [] };
}
