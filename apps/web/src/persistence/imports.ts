// Bringing imported reference bodies back when a document is opened: they live in the app and
// the kernel, not in regen, so after a reload (or opening another document) each reference
// import is read again from the file its feature stores. STEP files go through the kernel,
// STL files are parsed here. Loaded on first use, like the import code.

import type { ImportFeature, ManufaktureDocument } from '@manufakture/core';
import { fromBase64, parseStl } from '@manufakture/io';
import type { ImportedBody } from '../io/actions';
import type { Exchanger } from '../io/exchange';
import { meshBody } from '../io/meshBody';

/** The reference imports of every part, in document order. */
export function referenceImports(document: ManufaktureDocument): ImportFeature[] {
  return document.parts.flatMap((p) =>
    p.features.filter(
      (f): f is ImportFeature => f.kind === 'import' && f.operation === 'reference',
    ),
  );
}

export interface Restored {
  bodies: ImportedBody[];
  /** One message per import that could not be read again. */
  errors: string[];
}

/**
 * Read the reference bodies of `document` again. A STEP import needs the kernel (`exchanger`);
 * without one it is reported, as is any file the kernel or the STL reader refuses.
 */
export async function restoreImports(
  document: ManufaktureDocument,
  exchanger: Exchanger | null,
): Promise<Restored> {
  const bodies: ImportedBody[] = [];
  const errors: string[] = [];
  for (const feature of referenceImports(document)) {
    const { source } = feature;
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
      const read = await exchanger.importStep(bytes, feature.id, feature.name);
      if (read.ok) bodies.push({ feature, body: read.value });
      else errors.push(`${feature.name}: ${read.message}`);
    } else {
      try {
        const mesh = parseStl(bytes).mesh;
        bodies.push({ feature, body: meshBody(feature.id, mesh), mesh });
      } catch (e) {
        errors.push(`${feature.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { bodies, errors };
}
