// What the feature tree and the toolbar need to know about woodworking features, apart from the
// board and joint tools' logic (boards.ts, joints/joints.ts), which loads with their dialogs:
// whether a feature is a board or a joint, the domain's label for it, the stock a board is cut
// from and the boards a joint joins.

import type { ExtensionFeature, Feature } from '@manufakture/core';
import {
  BOARD_TYPE,
  findStock,
  JOINT_KINDS,
  JOINT_TYPE,
  readJointMetadata,
  type JointKind,
} from '@manufakture/domain-wood';

/** Whether a feature is a board (`wood.board`). */
export function isBoard(feature: Feature): feature is ExtensionFeature {
  return feature.kind === 'extension' && feature.extension === BOARD_TYPE;
}

/** Whether a feature is a joint (`wood.joint`). */
export function isJoint(feature: Feature): feature is ExtensionFeature {
  return feature.kind === 'extension' && feature.extension === JOINT_TYPE;
}

/** What each joint kind is called in the app. */
export const JOINT_LABELS: Readonly<Record<JointKind, string>> = {
  dado: 'Dado',
  rabbet: 'Rabbet',
  'mortise-tenon': 'Mortise and tenon',
  dowel: 'Dowels',
  'pocket-screw': 'Pocket screws',
  'box-joint': 'Box joint',
};

/** A joint's kind as stored, or null when it is not one this build knows. */
export function jointKindOf(feature: Feature): JointKind | null {
  if (!isJoint(feature)) return null;
  const kind = feature.params.kind;
  return (JOINT_KINDS as readonly unknown[]).includes(kind) ? (kind as JointKind) : null;
}

/** The domain's name for an extension feature's type ("Board", "Dado"), or null for an unknown type. */
export function extensionLabel(feature: Feature): string | null {
  if (isBoard(feature)) return 'Board';
  if (isJoint(feature)) {
    const kind = jointKindOf(feature);
    return kind ? JOINT_LABELS[kind] : 'Joint';
  }
  return null;
}

/** The stock a board is cut from, as the tree shows it (`2x4`), or null. */
export function boardStockName(feature: Feature): string | null {
  if (!isBoard(feature)) return null;
  const stock = feature.params.stock;
  if (typeof stock !== 'string') return null;
  return findStock(stock)?.name ?? stock;
}

/** How a count of hardware reads in the tree (`4 dowels`, `1 pocket screw`). */
function hardwareText(metadata: unknown): string[] {
  const meta = readJointMetadata(metadata);
  if (!meta) return [];
  return meta.hardware.map((h) => {
    const what = h.item === 'dowel' ? 'dowel' : 'pocket screw';
    return `${h.quantity} ${what}${h.quantity === 1 ? '' : 's'}`;
  });
}

/**
 * What the tree shows after a joint's name: the board entering the other (`Shelf into Side`),
 * and the hardware its last regen counted (`4 dowels`). Null for any other feature.
 */
export function jointDetail(
  feature: Feature,
  context: { features?: readonly Feature[]; metadata?: unknown } = {},
): string | null {
  if (!isJoint(feature)) return null;
  const name = (id: unknown) =>
    typeof id === 'string' ? (context.features?.find((f) => f.id === id)?.name ?? id) : '?';
  const parts = [`${name(feature.params.b)} into ${name(feature.params.a)}`];
  parts.push(...hardwareText(context.metadata));
  return parts.join(', ');
}
