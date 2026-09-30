// Bringing imported reference bodies back when a document is opened: they live in the app and
// the kernel, not in regen, so after a reload (or opening another document) each reference
// import is read again from the file its feature stores. STEP files go through the kernel,
// STL files are parsed here. Loaded on first use, like the import code.

import type { ImportFeature, ManufaktureDocument } from '@manufakture/core';
import { fromBase64, parseStl } from '@manufakture/io';
import type { ImportedBody } from '../io/actions';
import type { Exchanger } from '../io/exchange';
import { meshBody } from '../io/meshBody';
import { importBodyId } from '../io/restorable';

/** The reference imports of every part, in document order. */
export function referenceImports(document: ManufaktureDocument): ImportFeature[] {
  return referenceImportsByPart(document).map((i) => i.feature);
}

/** The reference imports of every part with the part studio each is in, in document order. */
export function referenceImportsByPart(
  document: ManufaktureDocument,
): { partId: string; feature: ImportFeature }[] {
  return document.parts.flatMap((p) =>
    p.features
      .filter((f): f is ImportFeature => f.kind === 'import' && f.operation === 'reference')
      .map((feature) => ({ partId: p.id, feature })),
  );
}

export interface Restored {
  bodies: ImportedBody[];
  /** One message per import that could not be read again. */
  errors: string[];
}

/**
 * Read the reference bodies of `document` again. A STEP import needs the kernel (`exchanger`);
 * without one it is reported, as is any file the kernel or the STL reader refuses. With `only`,
 * just the imports whose body ids (`importBodyId`) it holds: a part studio just duplicated.
 */
export async function restoreImports(
  document: ManufaktureDocument,
  exchanger: Exchanger | null,
  only?: ReadonlySet<string>,
): Promise<Restored> {
  const bodies: ImportedBody[] = [];
  const errors: string[] = [];
  for (const { partId, feature } of referenceImportsByPart(document)) {
    const { source } = feature;
    const bodyId = importBodyId(partId, feature.id);
    if (only && !only.has(bodyId)) continue;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(source.data);
    } catch {
      errors.push(`${feature.name}: the stored file is not readable.`);
      continue;
    }
    if (source.format === 'step') {
      if (!exchanger) {
        errors.push(`${feature.name}: STEP needs the geometry kernel.`);
        continue;
      }
      const read = await exchanger.importStep(bytes, feature.id, feature.name, bodyId);
      if (read.ok) bodies.push({ partId, feature, body: read.value });
      else errors.push(`${feature.name}: ${read.message}`);
    } else {
      try {
        const mesh = parseStl(bytes).mesh;
        bodies.push({ partId, feature, body: meshBody(bodyId, mesh), mesh });
      } catch (e) {
        errors.push(`${feature.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { bodies, errors };
}
