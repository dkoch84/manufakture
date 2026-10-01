// Documents and models for the print workspace's tests: part studios of axis-aligned boxes (the
// viewport's `boxBody`, with names and a planar topology), and setups built with the workspace's
// own commands.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type PrintItem,
} from '@manufakture/core';
import type { Vec3 } from '@manufakture/kernel';
import type { PartModel } from '../model/model';
import { boxBody } from '../viewport/testMeshes';
import { addItemCommand, addSetupCommand, editItemCommand } from './commands';

export function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

/** A document with `count` part studios, part#1 to part#<count>, named Part 1, Part 2, ... */
export function partsDocument(count = 1): ManufaktureDocument {
  let doc = apply(createDocument({ id: 'doc', name: 'Print test' }), {
    type: 'renamePart',
    partId: 'part#1',
    name: 'Part 1',
  });
  for (let i = 2; i <= count; i++) {
    doc = apply(doc, { type: 'addPart', partId: `part#${i}`, name: `Part ${i}` });
  }
  return doc;
}

export interface BoxSpec {
  bodyId: string;
  min?: Vec3;
  size?: Vec3;
}

/** A regenerated part of boxes; body view ids are `<part>/<body>`, face names `<view id>/top`. */
export function boxPart(partId: string, boxes: readonly BoxSpec[]): PartModel {
  return {
    partId,
    features: [],
    bodies: boxes.map((b) => ({
      bodyId: b.bodyId,
      creator: b.bodyId,
      solids: 1,
      view: boxBody({
        id: `${partId}/${b.bodyId}`,
        ...(b.min ? { min: b.min } : {}),
        ...(b.size ? { size: b.size } : {}),
      }),
    })),
  };
}

/** Add a setup (the X1 Carbon, 0.4 mm) and items; returns the document and the ids. */
export function withSetup(
  doc: ManufaktureDocument,
  items: readonly { part: string; body?: string; edit?: (item: PrintItem) => PrintItem }[],
): { doc: ManufaktureDocument; setupId: string; itemIds: string[] } {
  const setup = addSetupCommand(doc);
  doc = apply(doc, setup.command);
  const itemIds: string[] = [];
  for (const spec of items) {
    const add = addItemCommand(doc, setup.setupId, spec.part, spec.body);
    doc = apply(doc, add.command);
    itemIds.push(add.itemId);
    if (spec.edit) {
      const item = doc.print.setups
        .find((s) => s.id === setup.setupId)!
        .items.find((i) => i.id === add.itemId)!;
      doc = apply(doc, editItemCommand(setup.setupId, spec.edit(item)));
    }
  }
  return { doc, setupId: setup.setupId, itemIds };
}

/** The setup with this id. */
export function setupOf(doc: ManufaktureDocument, setupId: string) {
  return doc.print.setups.find((s) => s.id === setupId)!;
}
