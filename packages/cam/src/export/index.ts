// @manufakture/cam/export: CAM's fabrication files (M8 plan T8.1b): G-code with its setup sheet,
// and laser and plasma outlines as DXF or SVG. The document side of CAM, which the app's export
// dialogs used to hold: it reads the document's setups and operations and the regen geometry
// stage's replies, so it is apart from the package root, which never sees a document (ADR 0014
// decision 1). See README.md, "Exports".

import type { ManufaktureDocument } from '@manufakture/core';
import { exportAllowed, type ExportSource, type FabricationFile } from '@manufakture/io';
import { findMachine } from '../library/index';
import { createCamWorkerApi, type CamWorkerApi } from '../worker/api';
import { registerBuiltinOperations } from '../worker/builtin';
import { OperationRegistry } from '../worker/registry';
import type { CamGeometer } from './geometer';
import {
  buildExport,
  defaultExportSettings,
  exportFiles,
  type ExportPlan,
  type ExportSettings,
} from './gcode';
import {
  extractLoops,
  laserFile,
  type LaserFormat,
  type LaserScope,
  type LaserServices,
  type LaserSource,
  type OutlineSize,
} from './laser';
import { setupSheetHtml } from './sheet';
import { documentOperation, setupInput } from './setup';

export type { CamGeometer } from './geometer';
export {
  GCODE_MIME,
  HTML_MIME,
  MULTI_TOOL_LABELS,
  POST_MULTI_TOOL,
  ZIP_MIME,
  buildExport,
  defaultExportSettings,
  exportFiles,
  formatFeed,
  formatLength,
  formatSize,
  groupingWarnings,
  localDate,
  multiToolModes,
  originText,
  sheetFileName,
  toolLabel,
  withPost,
  type ExportBuild,
  type ExportInput,
  type ExportPlan,
  type ExportSettings,
  type ExportTool,
  type GeneratedToolpaths,
  type MultiToolMode,
  type PostedFile,
  type SheetOperation,
  type ToolChangeStep,
} from './gcode';
export {
  LASER_FORMATS,
  MAX_KERF,
  MAX_KERF_FRACTION,
  SECTION_DEFLECTION,
  defaultLayer,
  extractLoops,
  kernelLoop,
  kerfProblem,
  laserFile,
  laserSetupDocument,
  layerNameClashes,
  middleAlong,
  outlineSize,
  sameSource,
  sectionFrame,
  sectionPlanar,
  withSource,
  type Extraction,
  type LaserBody,
  type LaserFileResult,
  type LaserFormat,
  type LaserLayer,
  type LaserScope,
  type LaserServices,
  type LaserSource,
  type OutlineSize,
  type SectionAxis,
} from './laser';
export { POST_IDS, postName } from './posts';
export { escapeHtml, formatMinutes, setupSheetHtml, zeroingSteps } from './sheet';
export {
  CLEARING_SUFFIX,
  STOCK_Z_TOLERANCE,
  clearingInput,
  documentOperation,
  operationInput,
  setupInput,
  stockOf,
  stockOutline,
  type SetupBuild,
} from './setup';

export type GcodeExport =
  | {
      ok: true;
      /** What to save: the one G-code file, or a zip of the files per tool and the sheet. */
      files: FabricationFile[];
      /** The setup sheet, as HTML. */
      sheet: string;
      plan: ExportPlan;
    }
  | { ok: false; reasons: string[] };

/**
 * The G-code of CAM setup `setupId` of `document` (the entry point for headless sessions): its
 * geometry from regen's CAM stage (`geometer`, over `RegenEngine.camGeometry`), every operation
 * generated in-process (or on `options.api`), and the files written as the app's export dialog
 * writes them. `options.settings` changes the defaults (the setup's post, millimetres, the post's
 * first multi-tool mode, the user's order); `options.date` is the text the files and the sheet
 * carry. Refuses, with every reason, when the setup or its machine is unknown, the model changed
 * meanwhile, an operation's geometry or toolpath has an error, or the post refuses the job; and
 * first of all, before generating anything, when `options.source` (the branch `document` comes
 * from) is an agent's unreviewed branch or is not known (`exportAllowed`).
 */
export async function exportGcode(
  document: ManufaktureDocument,
  setupId: string,
  geometer: CamGeometer,
  options: {
    date: string;
    source: ExportSource | null;
    settings?: (defaults: ExportSettings) => ExportSettings;
    api?: CamWorkerApi;
  },
): Promise<GcodeExport> {
  const gate = exportAllowed(options?.source);
  if (!gate.ok) return { ok: false, reasons: [gate.message] };
  const setup = document.cam?.setups.find((s) => s.id === setupId);
  if (setup === undefined) return { ok: false, reasons: [`There is no CAM setup ${setupId}.`] };
  const machine = findMachine(setup.machine);
  if (machine === undefined) {
    return { ok: false, reasons: [`This version does not know the machine ${setup.machine}.`] };
  }
  const geometry = await geometer.geometry(document, setup.id);
  if (geometry === null) {
    return { ok: false, reasons: ['The model changed meanwhile; export again.'] };
  }
  const built = setupInput(geometry, setup);
  if (!built.ok) return { ok: false, reasons: [built.message] };
  const names = new Map(setup.operations.map((o) => [o.id, o.name]));
  const failed = Object.entries(built.failed).map(
    ([id, message]) => `${names.get(documentOperation(id)) ?? id}: ${message}`,
  );
  if (failed.length > 0) return { ok: false, reasons: failed };
  const api =
    options.api ??
    createCamWorkerApi({ operations: registerBuiltinOperations(new OperationRegistry()) });
  const reply = await api.generate({ generation: 1, setup: built.setup, machine });
  if (reply.status === 'cancelled')
    return { ok: false, reasons: ['The generation was cancelled.'] };
  if (reply.status === 'failed') {
    return { ok: false, reasons: [`Generation failed: ${reply.message}`] };
  }
  const defaults = defaultExportSettings(setup, machine);
  const result = buildExport({
    data: {
      setupId: setup.id,
      setup: built.setup,
      rapidRate: machine.maxRapid.value,
      operations: reply.operations,
    },
    operations: setup.operations,
    settings: options.settings ? options.settings(defaults) : defaults,
    jobName: document.name,
    setupName: setup.name,
    machine,
    date: options.date,
    source: options.source,
  });
  if (!result.ok) return { ok: false, reasons: [...result.reasons] };
  const sheet = setupSheetHtml(result.plan);
  return {
    ok: true,
    files: exportFiles(result.plan, sheet, options.source),
    sheet,
    plan: result.plan,
  };
}

export type LaserExport =
  | { ok: true; file: FabricationFile; warnings: string[]; size: OutlineSize }
  | { ok: false; messages: string[] };

/**
 * The laser or plasma file of `sources` (faces, sketch regions and sections of `scope`'s part,
 * each on a named layer; the entry point for headless sessions): their loops through `services`
 * (regen's CAM stage and the kernel's `section` op), compensated for `kerf` mm and written as the
 * app's laser dialog writes them. The warnings are the outline's and the file's. Refused before
 * any geometry is asked for when `options.source` (the branch `document` comes from) is an
 * agent's unreviewed branch or is not known (`exportAllowed`).
 */
export async function exportLaser(
  document: ManufaktureDocument,
  scope: LaserScope,
  sources: readonly LaserSource[],
  services: LaserServices,
  options: {
    format: LaserFormat;
    kerf: number;
    baseName: string;
    title?: string;
    source: ExportSource | null;
  },
): Promise<LaserExport> {
  const gate = exportAllowed(options?.source);
  if (!gate.ok) return { ok: false, messages: [gate.message] };
  const outline = await extractLoops(document, scope, sources, services);
  if (!outline.ok) return { ok: false, messages: outline.messages };
  const r = laserFile(outline.layers, options);
  if (!r.ok) return { ok: false, messages: [r.message] };
  return { ok: true, file: r.file, warnings: [...outline.warnings, ...r.warnings], size: r.size };
}
