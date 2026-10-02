// Small line icons for the feature tree: one per feature kind, and the status marks. Drawn in
// `currentColor` on a 16 x 16 grid, so CSS decides their colour.

import type { Feature, FeatureKind } from '@manufakture/core';
import type { ReactNode } from 'react';
import { isBoard, isJoint } from '../wood/kinds';
import type { RowStatus } from './tree';

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const KIND_PATHS: Record<FeatureKind, ReactNode> = {
  sketch: (
    <>
      <path d="M2.5 13.5h11" />
      <path d="M4 11l6.5-6.5 1.5 1.5L5.5 12.5H4z" />
    </>
  ),
  extrude: (
    <>
      <path d="M3 11.5h7l3-3H6z" />
      <path d="M3 11.5V5l3-3h7v6.5" />
      <path d="M3 5h7l3-3M10 5v6.5" />
    </>
  ),
  revolve: (
    <>
      <path d="M8 2v12" strokeDasharray="1.5 1.5" />
      <ellipse cx="8" cy="8" rx="5" ry="2.5" />
      <path d="M12 6.2l1 1.6 1.4-1" />
    </>
  ),
  fillet: (
    <>
      <path d="M2.5 13.5V7a4.5 4.5 0 0 1 4.5-4.5h6.5" />
      <path d="M2.5 13.5h11v-11" strokeDasharray="1.5 1.5" />
    </>
  ),
  chamfer: (
    <>
      <path d="M2.5 13.5V7l4.5-4.5h6.5" />
      <path d="M2.5 13.5h11v-11" strokeDasharray="1.5 1.5" />
    </>
  ),
  shell: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M5 5v6h6V5" />
    </>
  ),
  hole: (
    <>
      <ellipse cx="8" cy="4" rx="4" ry="1.6" />
      <path d="M4 4v8.5M12 4v8.5" />
      <path d="M4 12.5l4 2 4-2" />
    </>
  ),
  pattern: (
    <>
      <rect x="2" y="2" width="4" height="4" />
      <rect x="10" y="2" width="4" height="4" />
      <rect x="2" y="10" width="4" height="4" />
      <rect x="10" y="10" width="4" height="4" />
    </>
  ),
  mirror: (
    <>
      <path d="M8 1.5v13" strokeDasharray="1.5 1.5" />
      <path d="M6 4L2.5 12H6z" />
      <path d="M10 4l3.5 8H10z" />
    </>
  ),
  extension: (
    <>
      <path d="M3 8h10M8 3v10" />
      <circle cx="8" cy="8" r="5.5" />
    </>
  ),
  import: (
    <>
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M2.5 11v2.5h11V11" />
    </>
  ),
  derived: (
    <>
      <rect x="2.5" y="2.5" width="6" height="6" />
      <rect x="7.5" y="7.5" width="6" height="6" strokeDasharray="1.5 1.5" />
    </>
  ),
  thread: (
    <>
      <path d="M5 2v12M11 2v12" />
      <path d="M5 4l6-1.5M5 7l6-1.5M5 10l6-1.5M5 13l6-1.5" />
    </>
  ),
};

export function KindIcon({ kind }: { kind: FeatureKind }) {
  return <Svg className="kind-icon">{KIND_PATHS[kind]}</Svg>;
}

/** A board (`wood.board`): a plank with its grain. */
export function BoardIcon() {
  return (
    <Svg className="kind-icon">
      <rect x="1.5" y="5" width="13" height="6" />
      <path d="M3.5 7.2c2.5-.8 4.5.8 9 0M3.5 9c3-.6 5 .6 9-.2" />
    </Svg>
  );
}

/** A joint (`wood.joint`): one board standing in a groove of another. */
export function JointIcon() {
  return (
    <Svg className="kind-icon">
      <path d="M1.5 9.5h4.5v-2.5h4v2.5h4.5v4h-13z" />
      <rect x="6.5" y="1.5" width="3" height="8" />
    </Svg>
  );
}

/** A feature's icon: its domain's for the extension types the app knows, else its kind's. */
export function FeatureIcon({ feature }: { feature: Feature }) {
  if (isBoard(feature)) return <BoardIcon />;
  if (isJoint(feature)) return <JointIcon />;
  return <KindIcon kind={feature.kind} />;
}

const STATUS_PATHS: Partial<Record<RowStatus, ReactNode>> = {
  ok: <path d="M3.5 8.5l3 3 6-7" />,
  warning: (
    <>
      <path d="M8 2l6.5 12h-13z" />
      <path d="M8 6.5v3.5M8 12v.01" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  'upstream-error': (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v5M5.5 7.5L8 10l2.5-2.5" />
    </>
  ),
  suppressed: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.8 12.2l8.4-8.4" />
    </>
  ),
  'rolled-back': <path d="M4 10.5l4-4 4 4" />,
  pending: (
    <>
      <circle cx="8" cy="8" r="6" strokeDasharray="2 2" />
    </>
  ),
};

export function StatusIcon({ status }: { status: RowStatus }) {
  const path = STATUS_PATHS[status];
  return path ? <Svg className="status-icon">{path}</Svg> : null;
}

export type ActionName = 'edit' | 'rename' | 'suppress' | 'unsuppress' | 'delete';

const ACTION_PATHS: Record<ActionName, ReactNode> = {
  edit: <path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z" />,
  rename: (
    <>
      <path d="M2.5 11.5l2.5-7 2.5 7M3.5 9h3" />
      <path d="M11 3v10M9.5 3h3M9.5 13h3" />
    </>
  ),
  suppress: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.1 11.9l7.8-7.8" />
    </>
  ),
  unsuppress: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.2l1.8 1.8 3.2-3.8" />
    </>
  ),
  delete: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5" />
      <path d="M4.5 4.5l.7 9h5.6l.7-9" />
    </>
  ),
};

export function ActionIcon({ name }: { name: ActionName }) {
  return <Svg className="action-icon">{ACTION_PATHS[name]}</Svg>;
}
