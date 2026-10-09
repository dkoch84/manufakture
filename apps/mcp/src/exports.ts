// The `export` tool's formats, through the Node entry points of T8.1b (`@manufakture/io`'s README,
// "Fabrication exports"): each regenerates the session's head in the workshop and returns the
// files as `FabricationFile`s. Not gated (ADR 0016, "Acceptance"): any branch exports, an
// unreviewed agent branch included. A print setup's packed plate, IFC and `.mfkview` are not
// offered (see the README).
//
// Messages from the entry points can quote the document (a body, sheet or operation name), so
// they travel as `details`, data; the message composed here never does.

import { exportGcode, exportLaser, type LaserSource } from '@manufakture/cam/export';
import type { ManufaktureDocument } from '@manufakture/core';
import { DISCLAIMER_SHORT } from '@manufakture/domain-construction';
import { exportTakeoff } from '@manufakture/domain-construction/files';
import { exportCutList } from '@manufakture/domain-wood/files';
import {
  drawingFile,
  exportBodyFiles,
  kernelExchanger,
  memberExportBodies,
  type BodyFileFormat,
} from '@manufakture/io';
import type { DocumentLibrary } from '@manufakture/library';
import type { RegenResult } from '@manufakture/regen';
import type { z } from 'zod';
import type { OutFile } from './files';
import { serverError, type ServerError } from './results';
import type { ExportFormat, Inputs } from './schemas';
import { WorkshopTimeout, type Bench, type Workshop } from './workshop';

export type ExportInput = z.infer<(typeof Inputs)['export']>;

export type Made =
  { ok: true; files: OutFile[]; warnings: string[] } | { ok: false; error: ServerError };

const failed = (message: string, details: string[] = []): Made => ({
  ok: false,
  error: serverError('export', message, details.length > 0 ? { details } : {}),
});

const missing = (field: string, format: ExportFormat): Made => ({
  ok: false,
  error: serverError('invalid-input', `${format} needs ${field}.`),
});

/** Every body of the result, named as the app names them for export. */
function bodiesOf(result: RegenResult, doc: ManufaktureDocument, partId?: string) {
  return result.parts
    .filter((p) => partId === undefined || p.partId === partId)
    .flatMap((p) => {
      const part = doc.parts.find((x) => x.id === p.partId);
      const features = new Map(part?.features.map((f) => [f.id, f.name]));
      const named = new Map(part?.bodies.map((b) => [b.id, b.name]));
      return p.bodies.map((b) => ({
        id: `${p.partId}/${b.bodyId}`,
        name: named.get(b.bodyId) ?? b.inherited?.name ?? features.get(b.bodyId) ?? b.bodyId,
        shape: b.shape,
      }));
    });
}

const BODY_FORMATS: Partial<Record<ExportFormat, BodyFileFormat>> = {
  step: 'step',
  stl: 'stl',
  'stl-each': 'stl-each',
  '3mf': '3mf',
};

async function bodyFiles(
  input: ExportInput,
  doc: ManufaktureDocument,
  bench: Bench,
  format: BodyFileFormat,
): Promise<Made> {
  const { engine, kernel, result } = bench;
  if (input.partId !== undefined && !result.parts.some((p) => p.partId === input.partId)) {
    return { ok: false, error: serverError('invalid-input', 'There is no such part.') };
  }
  // Framing members: of the part asked for, or of the one part studio that has them.
  const withMembers = result.parts.filter((p) => (p.members ?? []).length > 0);
  const memberPart =
    input.partId !== undefined
      ? withMembers.find((p) => p.partId === input.partId)
      : withMembers.length === 1
        ? withMembers[0]
        : undefined;
  const meshes = new Map((result.memberMeshes?.added ?? []).map((m) => [m.key, m]));
  const members =
    memberPart === undefined
      ? []
      : memberExportBodies({
          meshes,
          sets: (memberPart.members ?? []).map((s) => ({ instances: s.instances ?? [] })),
        });
  const exchanger = kernelExchanger({
    kernel,
    generation: () => engine.generation,
    bodies: bodiesOf(result, doc, input.partId),
    memberBodies: (partId, ids, options) => engine.memberBodies(partId, ids, options),
  });
  const files = await exportBodyFiles(exchanger, format, {
    documentName: doc.name,
    ...(members.length > 0 ? { members, partId: memberPart!.partId } : {}),
    ...(members.length > 0 && format === 'step' ? { stepDescription: DISCLAIMER_SHORT } : {}),
  });
  if (!files.ok) return failed('The bodies could not be exported.', [files.message]);
  return { ok: true, files: files.files, warnings: files.note ? [files.note.trim()] : [] };
}

async function drawing(input: ExportInput, doc: ManufaktureDocument, bench: Bench): Promise<Made> {
  const format =
    input.format === 'drawing-pdf' ? 'pdf' : input.format === 'drawing-dxf' ? 'dxf' : 'svg';
  if (input.drawingId === undefined) return missing('drawingId', input.format);
  const d = (doc.drawings ?? []).find((x) => x.id === input.drawingId);
  if (d === undefined)
    return { ok: false, error: serverError('invalid-input', 'There is no such drawing.') };
  let sheets = d.sheets;
  if (format !== 'pdf') {
    const sheet =
      input.sheetId === undefined ? d.sheets[0] : d.sheets.find((s) => s.id === input.sheetId);
    if (sheet === undefined) {
      return { ok: false, error: serverError('invalid-input', 'There is no such sheet.') };
    }
    sheets = [sheet];
  }
  const lists = [];
  for (const sheet of sheets) {
    const laid = await bench.engine.drawingSheet(doc, d.id, sheet.id);
    lists.push(laid?.display ?? null);
  }
  const file = drawingFile(format, lists, { drawing: d.name, sheets: sheets.map((s) => s.name) });
  if (!file.ok) return failed('The drawing could not be exported.', [file.message]);
  return {
    ok: true,
    files: [{ name: file.fileName, bytes: file.bytes, type: file.type }],
    warnings: [],
  };
}

/** The files of `input.format`, from the session's head `doc` (or its branch, for `.mfk`). */
export async function makeExport(
  input: ExportInput,
  context: {
    document: ManufaktureDocument;
    documentId: string;
    branch: string;
    library: DocumentLibrary;
    workshop: Workshop;
    regenMs: number;
    /** The time an export's own work may take after its regen, ms. */
    workMs: number;
    now: () => Date;
  },
): Promise<Made> {
  const { document: doc } = context;
  if (input.format === 'mfk') {
    const packed = await context.library.exportMfk(context.documentId, { branch: context.branch });
    if (!packed.ok) return failed('The document could not be packed.', [packed.message]);
    return {
      ok: true,
      files: [{ name: packed.value.name, bytes: packed.value.bytes, type: 'application/zip' }],
      warnings: [],
    };
  }
  // The workshop holds the export's deadline: past it the caller is answered at once, while the
  // engine and the kernel stay the export's until its work has stopped (workshop.ts).
  const made = context.workshop.run(
    doc,
    context.regenMs,
    async (bench): Promise<Made> => {
      const signal = AbortSignal.timeout(context.workMs);
      const body = BODY_FORMATS[input.format];
      if (body !== undefined) return bodyFiles(input, doc, bench, body);
      switch (input.format) {
        case 'cut-list-csv':
        case 'bom-csv':
        case 'cut-list-pdf': {
          const kind =
            input.format === 'cut-list-csv' ? 'list' : input.format === 'bom-csv' ? 'bom' : 'pdf';
          if (
            input.assemblyId !== undefined &&
            !doc.assemblies.some((a) => a.id === input.assemblyId)
          ) {
            return { ok: false, error: serverError('invalid-input', 'There is no such assembly.') };
          }
          const file = await exportCutList(
            kind,
            {
              document: doc,
              parts: bench.result.parts,
              assemblies: bench.result.assemblies,
              ...(input.assemblyId !== undefined ? { assemblyId: input.assemblyId } : {}),
            },
            { signal },
          );
          return { ok: true, files: [file], warnings: [] };
        }
        case 'takeoff-csv':
        case 'takeoff-pdf': {
          const parts = bench.result.parts.filter((p) =>
            (p.members ?? []).some((s) => s.namespace === 'construction'),
          );
          const part =
            input.partId === undefined ? parts[0] : parts.find((p) => p.partId === input.partId);
          if (part === undefined) {
            return failed('There is no part studio with framing members to take off.');
          }
          const sets = (part.members ?? [])
            .filter((s) => s.members !== null)
            .map((s) => ({ namespace: s.namespace, members: s.members! }));
          const file = exportTakeoff(input.format === 'takeoff-csv' ? 'csv' : 'pdf', {
            document: doc,
            partId: part.partId,
            features: part.features,
            sets,
          });
          return { ok: true, files: [file], warnings: [] };
        }
        case 'drawing-pdf':
        case 'drawing-dxf':
        case 'drawing-svg':
          return drawing(input, doc, bench);
        case 'gcode': {
          if (input.setupId === undefined) return missing('setupId', input.format);
          const geometer = { geometry: bench.engine.camGeometry.bind(bench.engine) };
          const out = await exportGcode(doc, input.setupId, geometer, {
            date: context.now().toISOString().slice(0, 10),
          });
          if (!out.ok) return failed('The G-code could not be made.', out.reasons);
          return { ok: true, files: out.files, warnings: [] };
        }
        case 'laser-dxf':
        case 'laser-svg': {
          if (input.partId === undefined) return missing('partId', input.format);
          if (input.sources === undefined) return missing('sources', input.format);
          const part = bench.result.parts.find((p) => p.partId === input.partId);
          if (part === undefined) {
            return { ok: false, error: serverError('invalid-input', 'There is no such part.') };
          }
          const bodyId =
            input.bodyId ?? (part.bodies.length === 1 ? part.bodies[0]!.bodyId : undefined);
          if (bodyId === undefined) return missing('bodyId', input.format);
          const sources: LaserSource[] = input.sources.map((s) =>
            s.kind === 'face'
              ? { kind: 'face', ref: { face: s.face }, label: s.label, layer: s.layer }
              : { kind: 'region', sketch: s.sketch, label: s.label, layer: s.layer },
          );
          const out = await exportLaser(
            doc,
            { partId: part.partId, body: bodyId, viewId: `${part.partId}/${bodyId}` },
            sources,
            { geometer: { geometry: bench.engine.camGeometry.bind(bench.engine) } },
            {
              format: input.format === 'laser-dxf' ? 'dxf' : 'svg',
              kerf: input.kerf ?? 0,
              baseName: doc.name,
            },
          );
          if (!out.ok) return failed('The outline could not be made.', out.messages);
          return { ok: true, files: [out.file], warnings: out.warnings };
        }
        default:
          return failed('That format is not offered.');
      }
    },
    { workMs: context.workMs },
  );
  return made.catch((e: unknown): Made => {
    if (e instanceof WorkshopTimeout && e.stage === 'work') {
      return {
        ok: false,
        error: serverError('export', `The export took longer than ${context.workMs} ms.`, {
          limit: context.workMs,
        }),
      };
    }
    throw e;
  });
}
