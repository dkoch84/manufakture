// Placing a purchased part in the design (ADR 0017 decision 7): one undoable batch that adds a part
// studio holding its geometry, the `PurchasedUse` that names the entry and that part, and, when an
// assembly is given, an instance of the part in it.
//
// The geometry is the entry's STEP file, imported as a reference body exactly as the app imports a
// file today (an `import` feature, operation `reference`), or a `mech.placeholder` built from its
// dimensions. A STEP file in an entry is untrusted, whoever wrote the entry (the app's form, a
// shared document, a session): it gets `@manufakture/io`'s full `checkStepFile` here (size, the
// ISO 10303-21 signature, NUL bytes, its sections), and the kernel reads it in its own worker under
// its own limits, where a bad file is a feature error and never a failed regen.

import {
  INSTANCE_COUNTER,
  MAX_IMPORT_BYTES,
  MECH_COUNTERS,
  previewIds,
  type CatalogEntry,
  type CatalogRef,
  type Command,
  type Feature,
  type ManufaktureDocument,
  type PurchasedUse,
} from '@manufakture/core';
import { checkStepFile } from '@manufakture/io/step';
import { resolveEntry, type BuiltinEntry } from './catalog';
import { entryItem } from './bom';
import { hasBidiControl } from './families';
import { placeholderFeature } from './placeholder';

/** The longest name of a part studio, a use or an instance placing makes, in UTF-16 units. */
const MAX_NAME = 200;

/** `text` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `name`, or `name (2)`, `name (3)`... cut so the suffix always fits in `MAX_NAME`: the first
 * not in `taken`. Each candidate ends in its own suffix, so they all differ and the loop ends.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  let out = clip(name, MAX_NAME);
  for (let n = 2; taken.has(out); n++) {
    const suffix = ` (${n})`;
    out = clip(name, MAX_NAME - suffix.length) + suffix;
  }
  return out;
}

/**
 * The bytes of a base64 STEP blob, or why they cannot be used: base64, then `checkStepFile` (size
 * within core's import limit, the signature, no NUL byte, the sections). Pure; bounded by the blob
 * size.
 */
export function stepBytes(
  blob: string,
): { ok: true; bytes: Uint8Array } | { ok: false; message: string } {
  if (blob.length > Math.ceil(MAX_IMPORT_BYTES / 3) * 4) {
    return { ok: false, message: `the STEP file is over ${MAX_IMPORT_BYTES} bytes` };
  }
  let binary: string;
  try {
    binary = atob(blob);
  } catch {
    return { ok: false, message: 'the STEP file is not base64' };
  }
  if (binary.length === 0) return { ok: false, message: 'the STEP file is empty' };
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const check = checkStepFile(bytes, MAX_IMPORT_BYTES);
  if (!check.ok)
    return { ok: false, message: `the STEP file, line ${check.line}: ${check.message}` };
  return { ok: true, bytes };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The next `pp#n` of a document. */
export function nextUseId(doc: ManufaktureDocument): string {
  return `${MECH_COUNTERS.purchased}#${doc.mech?.nextIds[MECH_COUNTERS.purchased] ?? 1}`;
}

export interface PlaceOptions {
  /** Add an instance of the new part to this assembly. */
  assemblyId?: string;
  /** The part studio's and the use's name; default the entry's item text. */
  name?: string;
  /** Alternates the line lists. */
  alternates?: readonly CatalogRef[];
}

export type Placed =
  | {
      ok: true;
      command: Command;
      label: string;
      partId: string;
      featureId: string;
      useId: string;
      instanceId?: string;
    }
  | { ok: false; message: string };

function geometryFeature(
  entry: CatalogEntry | BuiltinEntry,
  ref: CatalogRef,
  name: string,
  sha: string | undefined,
  bytes: Uint8Array | undefined,
): { ok: true; feature: Feature } | { ok: false; message: string } {
  if (entry.geometry?.kind === 'step') {
    return {
      ok: true,
      feature: {
        id: 'import#1',
        kind: 'import',
        name: clip(name, MAX_NAME),
        suppressed: false,
        source: {
          format: 'step',
          fileName: `${entry.partNumber.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, MAX_NAME) || 'part'}.step`,
          size: bytes!.length,
          sha256: sha!,
          data: entry.geometry.blob,
        },
        operation: 'reference',
      },
    };
  }
  return placeholderFeature('extension#1', ref, entry, name);
}

/**
 * The batch that places the entry `ref` names: a new part studio with its geometry, the
 * purchased use and, with `assemblyId`, an instance (fixed when it is the assembly's first). The
 * ids are the document's next ones, so apply it to `doc` as it is.
 */
export async function placePurchasedPart(
  doc: ManufaktureDocument,
  ref: CatalogRef,
  options: PlaceOptions = {},
): Promise<Placed> {
  const resolved = resolveEntry(doc, ref);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const entry = resolved.entry;
  const name = clip((options.name ?? entryItem(entry)).trim(), MAX_NAME) || 'Purchased part';
  // A name from a shared document or a session must not reorder the text around it on screen.
  if (hasBidiControl(name)) {
    return { ok: false, message: 'the name holds a bidirectional control character' };
  }
  let sha: string | undefined;
  let bytes: Uint8Array | undefined;
  if (entry.geometry?.kind === 'step') {
    const read = stepBytes(entry.geometry.blob);
    if (!read.ok) return read;
    bytes = read.bytes;
    sha = await sha256Hex(bytes);
  }
  const feature = geometryFeature(entry, ref, name, sha, bytes);
  if (!feature.ok) return feature;
  const [partId] = previewIds(doc.nextIds, 'part');
  const useId = nextUseId(doc);
  const use: PurchasedUse = {
    id: useId,
    entry: { ...ref },
    part: partId!,
    alternates: (options.alternates ?? []).map((r) => ({ ...r })),
    name,
  };
  const commands: Command[] = [
    { type: 'addPart', partId: partId!, name },
    { type: 'addFeature', partId: partId!, feature: feature.feature },
    { type: 'setPurchasedUse', use },
  ];
  let instanceId: string | undefined;
  if (options.assemblyId !== undefined) {
    const assembly = doc.assemblies.find((a) => a.id === options.assemblyId);
    if (assembly === undefined)
      return { ok: false, message: `there is no assembly ${options.assemblyId}` };
    [instanceId] = previewIds(assembly.nextIds, INSTANCE_COUNTER);
    const instanceName = uniqueName(name, new Set(assembly.instances.map((i) => i.name)));
    commands.push({
      type: 'addInstance',
      assemblyId: assembly.id,
      instance: {
        id: instanceId!,
        name: instanceName,
        source: { part: partId! },
        fixed: assembly.instances.length === 0,
        suppressed: false,
        pose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      },
    });
  }
  return {
    ok: true,
    command: { type: 'batch', commands },
    label: `Place ${name}`,
    partId: partId!,
    featureId: feature.feature.id,
    useId,
    ...(instanceId !== undefined ? { instanceId } : {}),
  };
}
