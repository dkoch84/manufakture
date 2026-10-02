// The commands the Manufacture workspace runs (M5 plan, T5.3a): a new setup, setup edits, the WCS
// face, and the operation list's rename, suppress, reorder, delete and move between setups. Each is
// one core command (a move is one batch), so one undo step. Ids come from the CAM section's own
// counters (`setup#n`, `<kind>#n`, `r<n>`; ADR 0014 decision 4), previewed here and checked fresh by
// core.

import {
  CAM_SETUP_COUNTER,
  createCamSetup,
  findPart,
  previewIds,
  type CamOperation,
  type CamSetup,
  type Command,
  type FaceRef,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  DEFAULT_MACHINE_ID,
  MACHINES,
  defaultPost,
  feedCategoryOf,
  type MachineProfile,
} from '@manufakture/cam/library';
import { explicit } from './values';

/**
 * The margins a new setup's stock starts with: 5 mm on every side, 1 mm above the part (a facing
 * pass cleans it off) and none below it (the part sits on the spoilboard).
 */
export const DEFAULT_MARGINS = { side: '5 mm', top: '1 mm', bottom: '0 mm' } as const;

/**
 * The post ids this build writes. Kept as a list here (and checked against `packages/cam`'s
 * `BUILTIN_POST_IDS` in the tests) so that the workspace's eager code does not load the whole CAM
 * package for one set of names.
 */
export const POST_IDS: readonly string[] = [
  'grbl',
  'carbide-motion',
  'grblhal',
  'linuxcnc',
  'mach3',
];

/** Display names of the posts (`packages/cam`'s dialect names). */
export const POST_NAMES: Readonly<Record<string, string>> = {
  grbl: 'Grbl 1.1',
  'carbide-motion': 'Carbide Motion',
  grblhal: 'grblHAL',
  linuxcnc: 'LinuxCNC',
  mach3: 'Mach3',
};

/** A post's display name; the id itself for one this build does not know. */
export function postName(id: string): string {
  return Object.hasOwn(POST_NAMES, id) ? POST_NAMES[id]! : id;
}

/**
 * The machine table row `id`, by a Map lookup (ids are data from a document and may be any CAM
 * table id, `constructor` included); undefined for one this build does not know.
 */
const MACHINE_BY_ID: ReadonlyMap<string, MachineProfile> = new Map(MACHINES.map((m) => [m.id, m]));
export function machineById(id: string): MachineProfile | undefined {
  return MACHINE_BY_ID.get(id);
}

/** The machine a new setup uses: the Shapeoko 5 Pro 4x4 (the project owner's decision). */
export function defaultMachine(): MachineProfile {
  return machineById(DEFAULT_MACHINE_ID)!;
}

/** The post a setup on `machine` starts with: its first suitable post this build writes. */
export function machinePost(machine: MachineProfile): string {
  return defaultPost(machine, POST_IDS) ?? defaultPost(machine);
}

/** The first `Setup n` no setup is called yet. */
export function newSetupName(doc: ManufaktureDocument): string {
  const names = new Set(doc.cam.setups.map((s) => s.name));
  let n = doc.cam.setups.length + 1;
  while (names.has(`Setup ${n}`)) n++;
  return `Setup ${n}`;
}

/**
 * The stock material a setup of `partId` (and body `bodyId`) starts with: the feed category of
 * the body's material, else the part's; none when neither is set or has no category.
 */
export function partFeedCategory(
  doc: ManufaktureDocument,
  partId: string,
  bodyId?: string,
): string | undefined {
  const part = findPart(doc, partId);
  if (!part) return undefined;
  const body = bodyId === undefined ? undefined : part.bodies.find((b) => b.id === bodyId);
  const material = body?.material ?? part.material;
  return material === undefined ? undefined : feedCategoryOf(material);
}

/**
 * A new setup of part `partId`: on the default machine with its default post, stock from the
 * body's bounds plus `DEFAULT_MARGINS`, the material from the part's, Z up, origin at the front
 * left of the stock top, clearance 10 mm and retract 5 mm.
 */
export function newSetup(
  doc: ManufaktureDocument,
  partId: string,
  bodyId?: string,
): { setup: CamSetup; setupId: string } {
  const [setupId] = previewIds(doc.cam.nextIds, CAM_SETUP_COUNTER);
  const machine = defaultMachine();
  const base = createCamSetup(
    setupId!,
    newSetupName(doc),
    partId,
    machine.id,
    machinePost(machine),
  );
  const units = doc.units;
  const side = explicit(DEFAULT_MARGINS.side, units);
  const material = partFeedCategory(doc, partId, bodyId);
  const setup: CamSetup = {
    ...base,
    ...(bodyId !== undefined ? { body: bodyId } : {}),
    stock: {
      kind: 'fromBody',
      margins: {
        xMin: side,
        xMax: side,
        yMin: side,
        yMax: side,
        top: explicit(DEFAULT_MARGINS.top, units),
        bottom: explicit(DEFAULT_MARGINS.bottom, units),
      },
      ...(material !== undefined ? { material } : {}),
    },
    heights: { clearance: explicit('10 mm', units), retract: explicit('5 mm', units) },
  };
  return { setup, setupId: setupId! };
}

export function addSetupCommand(
  doc: ManufaktureDocument,
  partId: string,
  bodyId?: string,
): { command: Command; setupId: string } {
  const { setup, setupId } = newSetup(doc, partId, bodyId);
  return { command: { type: 'addCamSetup', setup }, setupId };
}

export type SetupChanges = Omit<Extract<Command, { type: 'editCamSetup' }>, 'type' | 'setupId'>;

export function editSetupCommand(setupId: string, changes: SetupChanges): Command {
  return { type: 'editCamSetup', setupId, ...changes };
}

/** Make the setup's machine `machine`, and its post that machine's default when it has one. */
export function machineCommand(setup: CamSetup, machine: MachineProfile): Command {
  return editSetupCommand(setup.id, { machine: machine.id, post: machinePost(machine) });
}

/** The setup's WCS up direction from a planar face, under a fresh reference id. */
export function wcsFaceCommand(doc: ManufaktureDocument, setup: CamSetup, face: FaceRef): Command {
  const [id] = previewIds(doc.cam.nextIds, 'r');
  return editSetupCommand(setup.id, {
    wcs: { ...setup.wcs, up: { kind: 'face', face: { id: id!, ref: face } } },
  });
}

export function renameOperationCommand(setupId: string, op: CamOperation, name: string): Command {
  return { type: 'editCamOperation', setupId, operation: { ...op, name } };
}

export function suppressOperationCommand(
  setupId: string,
  op: CamOperation,
  suppressed: boolean,
): Command {
  return { type: 'suppressCamOperation', setupId, operationId: op.id, suppressed };
}

export function reorderOperationCommand(setupId: string, operationId: string, index: number) {
  return { type: 'reorderCamOperation', setupId, operationId, index } satisfies Command;
}

export function deleteOperationCommand(setupId: string, operationId: string): Command {
  return { type: 'deleteCamOperation', setupId, operationId };
}

/**
 * Whether an operation can move between setups `a` and `b`: they machine the same part and the
 * same body (a setup with no body chosen only matches another with none). Feature ids are per
 * part, and a feature that cuts two bodies names its faces alike on both, so an operation moved
 * to another part or body would resolve its faces, sketches and holes on look-alike geometry.
 */
export function sameWorkpiece(a: CamSetup, b: CamSetup): boolean {
  return a.part === b.part && (a.body ?? null) === (b.body ?? null);
}

/**
 * Move an operation to the end of another setup's cut order under its own id: one batch of
 * `deleteCamOperation` and `restoreCamOperation`, so one undo step. Only between setups of the
 * same part and body (`sameWorkpiece`). Null when the move cannot be made.
 */
export function moveOperationCommand(
  doc: ManufaktureDocument,
  fromSetupId: string,
  operationId: string,
  toSetupId: string,
): Command | null {
  const from = doc.cam.setups.find((s) => s.id === fromSetupId);
  const to = doc.cam.setups.find((s) => s.id === toSetupId);
  const op = from?.operations.find((o) => o.id === operationId);
  if (!from || !to || !op || from === to || !sameWorkpiece(from, to)) return null;
  return {
    type: 'batch',
    commands: [
      { type: 'deleteCamOperation', setupId: from.id, operationId },
      {
        type: 'restoreCamOperation',
        setupId: to.id,
        operation: op,
        index: to.operations.length,
      },
    ],
  };
}

export function deleteToolCommand(toolId: string): Command {
  return { type: 'deleteCamTool', toolId };
}
