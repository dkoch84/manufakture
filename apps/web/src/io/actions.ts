// Export and import, as the menus run them. Kept free of React so they can be
// tested with a fake kernel exchange and a real document store.

import {
  MAX_IMPORT_BYTES,
  findPart,
  previewIds,
  type ImportFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  EXPORT_TOLERANCES,
  NotWatertightError,
  deflectionOf,
  export3mf,
  exportStl,
  fileName,
  fromBase64,
  importSource,
  parseStl,
  sniffFormat,
  stepProductNames,
  type ExportBody,
  type ExportTolerancePreset,
  type TriMesh,
} from '@manufakture/io';
import type { DocumentStoreApi } from '../state/document';
import type { BodyInput } from '../viewport/bodies';
import type { Exchanger } from './exchange';
import { MIME, formatBytes } from './files';
import { shownMemberExports } from './memberExport';
import { meshBody } from './meshBody';
import { importBodyId } from './restorable';

export type ExportFormat = 'stl' | 'stl-each' | '3mf' | 'step';

export interface ExportedFile {
  name: string;
  bytes: Uint8Array;
  type: string;
}

export type ActionResult<T> =
  { ok: true; value: T; message: string } | { ok: false; message: string };

/** A body to export: its viewport id, and the name its object, product or file gets. */
export interface ExportChoice {
  id: string;
  name: string;
}

/**
 * Export B-rep bodies: `options.bodies` (the ones the user chose, under the names given), or
 * every part body the kernel holds. The files are named after the one body, or the document
 * when there are several (`options.fileBase` overrides both). Binary STL (all bodies in one file, or one file per body),
 * 3MF (one named object per body) or STEP (one named product per body). Mesh exports are
 * tessellated at `tolerance` and must be watertight.
 *
 * Framing members (`options.members`, by default the ones the viewport shows) go into mesh
 * exports after the bodies (ADR 0015 decision 4): one 3MF object per member named by its full id,
 * appended to a merged STL, or one more STL of them all when each body gets a file. STEP leaves
 * them out (member B-reps are built on demand, a later task).
 */
export async function exportBodies(
  exchanger: Exchanger,
  format: ExportFormat,
  options: {
    tolerance?: ExportTolerancePreset;
    documentName?: string;
    bodies?: readonly ExportChoice[];
    /** The file name, without extension, whatever the bodies are (default: see below). */
    fileBase?: string;
    /** Framing members, placed and named (default: the members the viewport shows). */
    members?: readonly ExportBody[];
  } = {},
): Promise<ActionResult<ExportedFile[]>> {
  const bodies = options.bodies ?? exchanger.bodies();
  const members = options.members ?? shownMemberExports();
  if (bodies.length === 0 && (members.length === 0 || format === 'step')) {
    return { ok: false, message: 'There is nothing to export.' };
  }
  const ids = bodies.map((b) => b.id);
  const names = options.bodies ? new Map(bodies.map((b) => [b.id, b.name])) : undefined;
  const base =
    options.fileBase ??
    (bodies.length === 1 ? bodies[0]!.name : (options.documentName ?? 'bodies'));
  let files: ExportedFile[];
  if (format === 'step') {
    const step = names ? await exchanger.exportStep(ids, names) : await exchanger.exportStep(ids);
    if (!step.ok) return step;
    files = [{ name: fileName(base, 'step'), bytes: step.value, type: MIME.step }];
  } else {
    const tolerance = EXPORT_TOLERANCES[options.tolerance ?? 'normal'];
    const deflection = deflectionOf(tolerance);
    const meshes =
      ids.length === 0
        ? { ok: true as const, value: [] }
        : names
          ? await exchanger.tessellate(ids, deflection, names)
          : await exchanger.tessellate(ids, deflection);
    if (!meshes.ok) return meshes;
    const all = [...meshes.value, ...members];
    try {
      if (format === '3mf') {
        files = [
          {
            name: fileName(base, '3mf'),
            bytes: export3mf(all, { title: base }),
            type: MIME['3mf'],
          },
        ];
      } else if (format === 'stl') {
        files = exportStl(all, { merge: true, fileName: base }).map((f) => ({
          ...f,
          type: MIME.stl,
        }));
      } else {
        // One file per body; the members, often hundreds, together in one more.
        files = [
          ...exportStl(meshes.value, { merge: false }),
          ...(members.length > 0
            ? exportStl(members, { merge: true, fileName: `${base} members` })
            : []),
        ].map((f) => ({ ...f, type: MIME.stl }));
      }
    } catch (e) {
      if (e instanceof NotWatertightError) return { ok: false, message: e.message };
      throw e;
    }
  }
  const summary = files.map((f) => `${f.name} (${formatBytes(f.bytes.length)})`).join(', ');
  const skipped =
    format === 'step' && members.length > 0 ? ' Framing members are not exported to STEP yet.' : '';
  return { ok: true, value: files, message: `Exported ${summary}.${skipped}` };
}

/** Largest file an import accepts (core's limit): it is kept inside the document, as base64. */
export { MAX_IMPORT_BYTES };

export interface ImportedBody {
  /** The part studio the import feature is in. */
  partId: string;
  feature: ImportFeature;
  /** Its viewport id is `importBodyId(partId, feature.id)`. */
  body: BodyInput;
  /** Set for an STL import: the welded mesh, which the mesh measurer uses. */
  mesh?: TriMesh;
}

/**
 * Import a STEP or STL file as a reference body: read it (STEP in the
 * kernel, STL here), then add an `import` feature holding the file to the
 * document, as one undoable step. The body's viewport id is the feature id qualified with the
 * part studio (`importBodyId`).
 */
export async function importFile(
  file: { name: string; bytes: Uint8Array },
  documents: DocumentStoreApi,
  exchanger: Exchanger | null,
  partId: string = documents.getState().activePartId,
): Promise<ActionResult<ImportedBody>> {
  const { bytes } = file;
  if (bytes.length === 0) return { ok: false, message: `${file.name} is empty.` };
  if (bytes.length > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: `${file.name} is ${formatBytes(bytes.length)}; imports are limited to ${formatBytes(MAX_IMPORT_BYTES)}.`,
    };
  }
  const format = sniffFormat(bytes, file.name);
  if (format !== 'step' && format !== 'stl') {
    return { ok: false, message: `${file.name} is not a STEP or STL file.` };
  }
  const doc: ManufaktureDocument = documents.getState().document;
  const part = findPart(doc, partId);
  if (!part) return { ok: false, message: `There is no part ${partId}.` };
  const [featureId] = previewIds(part.nextIds, 'import');
  const bodyId = importBodyId(partId, featureId!);
  const stem = file.name.replace(/\.[^.]*$/, '') || file.name;

  let body: BodyInput;
  let mesh: TriMesh | undefined;
  let name: string;
  if (format === 'step') {
    if (!exchanger) return { ok: false, message: 'STEP import needs the geometry kernel.' };
    name =
      stepProductNames(bytes)
        .find((n) => n.trim().length > 0)
        ?.trim() ?? stem;
    const read = await exchanger.importStep(bytes, featureId!, name, bodyId);
    if (!read.ok) return read;
    body = read.value;
  } else {
    try {
      const stl = parseStl(bytes);
      name = stl.name.length > 0 && stl.format === 'ascii' ? stl.name : stem;
      mesh = stl.mesh;
      body = meshBody(bodyId, stl.mesh);
    } catch (e) {
      return { ok: false, message: `${file.name}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const feature: ImportFeature = {
    id: featureId!,
    kind: 'import',
    name: name.slice(0, 200),
    suppressed: false,
    source: await importSource(format, file.name.slice(0, 255), bytes),
    operation: 'reference',
  };
  const added = documents
    .getState()
    .execute({ type: 'addFeature', partId, feature }, `Import ${file.name}`);
  if (!added.ok) return { ok: false, message: added.error.message };
  const kind = format === 'step' ? 'STEP' : 'STL mesh';
  return {
    ok: true,
    value: mesh ? { partId, feature, body, mesh } : { partId, feature, body },
    message: `Imported ${file.name} as ${feature.name} (${kind}, a reference body).`,
  };
}

/**
 * Read the STEP reference bodies of `imports` into the kernel again, from the files their
 * features store, after the kernel lost every shape (a recycle or a restart). STL references
 * are meshes the kernel never held, so they are left alone. Returns the body ids rebuilt.
 */
export function reimportSteps(
  exchanger: Exchanger,
  imports: readonly Pick<ImportedBody, 'partId' | 'feature'>[],
): Promise<string[]> {
  const files = new Map<string, Uint8Array>();
  for (const { partId, feature: f } of imports) {
    if (f.source.format !== 'step') continue;
    try {
      files.set(importBodyId(partId, f.id), fromBase64(f.source.data));
    } catch {
      // A document that validated holds base64; skip anything else rather than fail the rest.
    }
  }
  return files.size === 0 ? Promise.resolve([]) : exchanger.reimport(files);
}

export { importBodyId, restorableImportIds } from './restorable';
