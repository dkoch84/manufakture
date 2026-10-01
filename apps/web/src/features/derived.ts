// Derived parts in the app, free of React: pinning a part of a named version (reading the version
// back from the library, its imports and pins inline, and hashing its canonical text), the bodies
// a source part offers, the derived part dialog's form and the command it builds, and the update
// of a pin to another version. The pinned-part picker (PinnedPartPicker.tsx) and the feature tree
// use the same pieces, and so will assembly instances of pinned parts (T2.3e).

import {
  MAX_DERIVED_BYTES,
  MAX_DERIVED_DEPTH,
  bareUnits,
  bodyCreator,
  defaultFeatureName,
  deserialize,
  findPart,
  isFeatureActive,
  previewIds,
  serialize,
  utf8Length,
  type Command,
  type DerivedFeature,
  type DerivedSource,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import { sha256Hex } from '@manufakture/io';
import type { DocumentSummary, LibraryResult, Version, VersionMeta } from '../persistence/library';
import { evaluateVariables } from '../sketcher/values';
import { checkExpression, type Operation, type ScopeBody } from './forms';

/** What pinning and updating need of the document library. */
export interface PinLibrary {
  list(): Promise<DocumentSummary[]>;
  listVersions(id: string): Promise<LibraryResult<Version[]>>;
  readVersion(
    id: string,
    versionId: string,
  ): Promise<LibraryResult<{ version: Version; document: ManufaktureDocument }>>;
  createVersion(id: string, meta: VersionMeta): Promise<LibraryResult<Version>>;
}

/** A pinned part: the source to store, and the source document it was read from. */
export interface PinnedPart {
  source: DerivedSource;
  document: ManufaktureDocument;
}

const failure = (e: unknown): { ok: false; message: string } => ({
  ok: false,
  message: e instanceof Error ? e.message : String(e),
});

/**
 * The pin of part `partId` of `document` at `version`: `data` is the canonical text of the
 * document (its imports and pins inline, as the library hydrates them), `size` its UTF-8 length
 * and `sha256` the hash of those bytes. Refused when the part is not in it, or the text is over
 * `MAX_DERIVED_BYTES`. `configuration` is carried as given (T2.4c chooses it).
 */
export async function pinOf(
  document: ManufaktureDocument,
  version: Pick<Version, 'id' | 'name'>,
  partId: string,
  options: { documentName?: string; configuration?: string } = {},
): Promise<LibraryResult<DerivedSource>> {
  if (!findPart(document, partId)) {
    return { ok: false, message: `The version "${version.name}" has no part studio ${partId}.` };
  }
  let data: string;
  try {
    data = serialize(document);
  } catch (e) {
    return failure(e);
  }
  const size = utf8Length(data);
  if (size > MAX_DERIVED_BYTES) {
    const mib = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MiB`;
    return {
      ok: false,
      message: `The version "${version.name}" is ${mib(size)}, over the ${mib(MAX_DERIVED_BYTES)} a derived part can hold.`,
    };
  }
  return {
    ok: true,
    value: {
      documentId: document.id,
      documentName: options.documentName ?? document.name,
      versionId: version.id,
      versionName: version.name,
      partId,
      ...(options.configuration !== undefined ? { configuration: options.configuration } : {}),
      size,
      sha256: await sha256Hex(new TextEncoder().encode(data)),
      data,
    },
  };
}

/** Read version `version` of document `documentId` from the library and pin its part `partId`. */
export async function readPin(
  library: PinLibrary,
  documentId: string,
  version: Pick<Version, 'id' | 'name'>,
  partId: string,
  options: { documentName?: string; configuration?: string } = {},
): Promise<LibraryResult<PinnedPart>> {
  try {
    const read = await library.readVersion(documentId, version.id);
    if (!read.ok) return read;
    const pinned = await pinOf(read.value.document, read.value.version, partId, options);
    return pinned.ok
      ? { ok: true, value: { source: pinned.value, document: read.value.document } }
      : pinned;
  } catch (e) {
    return failure(e);
  }
}

/** The document a pin holds, or null when it does not read (regen says why on the feature). */
export function pinnedDocument(source: DerivedSource): ManufaktureDocument | null {
  const r = deserialize(source.data);
  return r.ok ? r.value.document : null;
}

/**
 * The bodies a part offers to derive, as far as the document says without regenerating it: one
 * per active extrude, revolve or import that makes a new body; a derived feature's own bodies
 * (those it names, or every one its source offers); and every body the part has settings for
 * (named or coloured ones, pattern copies included) whose feature is active. In body order,
 * with their names. A body this misses is still derived when **All bodies** is chosen.
 */
export function sourceBodies(doc: ManufaktureDocument, partId: string, depth = 0): ScopeBody[] {
  const part = findPart(doc, partId);
  if (!part) return [];
  const out: ScopeBody[] = [];
  const named = (bodyId: string, fallback: string) =>
    part.bodies.find((b) => b.id === bodyId)?.name ?? fallback;
  const add = (bodyId: string, fallback: string) => {
    if (!out.some((b) => b.bodyId === bodyId)) {
      out.push({ bodyId, name: named(bodyId, fallback) });
    }
  };
  part.features.forEach((f, i) => {
    if (!isFeatureActive(part, i)) return;
    if (
      (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'import') &&
      f.operation === 'new'
    ) {
      add(f.id, f.name);
    } else if (f.kind === 'derived' && f.operation === 'new' && depth < MAX_DERIVED_DEPTH) {
      const ids =
        f.bodies ??
        (() => {
          const nested = pinnedDocument(f.source);
          return nested
            ? sourceBodies(nested, f.source.partId, depth + 1).map((b) => b.bodyId)
            : [];
        })();
      for (const id of ids) add(`${f.id}:from/${id}`, `${f.name}: ${id}`);
    }
  });
  const order = new Map(part.features.map((f, i) => [f.id, i]));
  for (const b of part.bodies) {
    const at = order.get(bodyCreator(b.id) ?? '');
    if (at !== undefined && isFeatureActive(part, at)) add(b.id, b.id);
  }
  return out;
}

/** The part studios of a source document, for the part choice. */
export function sourceParts(doc: ManufaktureDocument): Pick<Part, 'id' | 'name'>[] {
  return doc.parts.map((p) => ({ id: p.id, name: p.name }));
}

// The form ---------------------------------------------------------------------------------------

export interface DerivedForm {
  kind: 'derived';
  /** The pin; null until a document, version and part are chosen. */
  source: DerivedSource | null;
  /** Source body ids; absent: every body. */
  bodies?: string[];
  /** Translation x, y, z and rotation about x, y, z, as typed. */
  translation: [string, string, string];
  rotation: [string, string, string];
  operation: Operation;
  /** The bodies the operation combines with (not for a new body); absent: every body. */
  scope?: string[];
}

export function newDerivedForm(): DerivedForm {
  return {
    kind: 'derived',
    source: null,
    translation: ['0', '0', '0'],
    rotation: ['0', '0', '0'],
    operation: 'new',
  };
}

const text = (e: StoredExpression) => e.source;

export function derivedFormOf(feature: DerivedFeature): DerivedForm {
  const t = feature.placement.translation;
  const r = feature.placement.rotation;
  return {
    kind: 'derived',
    source: feature.source,
    ...(feature.bodies !== undefined ? { bodies: [...feature.bodies] } : {}),
    translation: [text(t[0]), text(t[1]), text(t[2])],
    rotation: [text(r[0]), text(r[1]), text(r[2])],
    operation: feature.operation,
    ...(feature.scope !== undefined ? { scope: [...feature.scope] } : {}),
  };
}

export type DerivedBuild =
  | { ok: true; feature: DerivedFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

const AXES = ['x', 'y', 'z'] as const;

/**
 * The derived feature a filled form makes, and the command that adds it at the rollback bar (or
 * edits `existing`). Field errors are keyed `source`, `bodies`, `translation-x` (and `-y`,
 * `-z`), `rotation-x` and so on, and `scope`.
 */
export function buildDerived(
  form: DerivedForm,
  ctx: { doc: ManufaktureDocument; partId: string; existing?: DerivedFeature },
): DerivedBuild {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { ok: false, errors: { form: `There is no part ${ctx.partId}.` } };
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  const errors: Record<string, string> = {};
  const expr = (field: string, source: string, kind: 'length' | 'angle'): StoredExpression => {
    const r = checkExpression(source, kind, units, variables);
    if (r.ok) return r.expression;
    errors[field] = r.message;
    return { source, ...bareUnits(units) };
  };
  const translation = AXES.map((a, i) =>
    expr(`translation-${a}`, form.translation[i]!, 'length'),
  ) as [StoredExpression, StoredExpression, StoredExpression];
  const rotation = AXES.map((a, i) => expr(`rotation-${a}`, form.rotation[i]!, 'angle')) as [
    StoredExpression,
    StoredExpression,
    StoredExpression,
  ];
  if (!form.source) errors.source = 'Choose a document, a version and a part studio.';
  if (form.bodies !== undefined && form.bodies.length === 0) {
    errors.bodies = 'Choose at least one body.';
  }
  const existing = ctx.existing;
  const id = existing?.id ?? previewIds(part.nextIds, 'derived')[0]!;
  const name = existing?.name ?? defaultFeatureName('derived', id);
  const feature: DerivedFeature = {
    id,
    kind: 'derived',
    name,
    suppressed: existing?.suppressed ?? false,
    source: form.source ?? (existing?.source as DerivedSource),
    placement: { translation, rotation },
    operation: form.operation,
  };
  if (form.bodies !== undefined && form.bodies.length > 0) feature.bodies = [...form.bodies];
  if (form.scope !== undefined && form.operation !== 'new') {
    if (form.scope.length === 0) errors.scope = 'Choose at least one body.';
    else feature.scope = [...form.scope];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const command: Command = existing
    ? { type: 'editFeature', partId: ctx.partId, feature }
    : { type: 'addFeature', partId: ctx.partId, feature };
  return { ok: true, feature, command, label: `${existing ? 'Edit' : 'Add'} ${name}` };
}

// Versions and updates ---------------------------------------------------------------------------

/**
 * The versions of a source named after the pinned one, oldest first (the library lists them in
 * the order they were made). Null when the pinned version is not in the list (the source is
 * gone, or is another copy of it): nothing can be said about newer ones.
 */
export function newerVersions(
  versions: readonly Version[],
  pinnedVersionId: string,
): Version[] | null {
  const at = versions.findIndex((v) => v.id === pinnedVersionId);
  return at < 0 ? null : versions.slice(at + 1);
}

/** The command that moves `feature`'s pin to `source` (one undo step), and its label. */
export function updatePin(
  partId: string,
  feature: DerivedFeature,
  source: DerivedSource,
): { command: Command; label: string } {
  return {
    command: { type: 'editFeature', partId, feature: { ...feature, source } },
    label: `Update ${feature.name} to "${source.versionName}"`,
  };
}

/** How a pin is shown: "Bracket at 6 mm". */
export function pinLabel(source: DerivedSource): string {
  return `${source.documentName || source.documentId} at ${source.versionName || source.versionId}`;
}

/**
 * Read `version` of `feature`'s source document and pin the same part (and configuration, and
 * the document name it was pinned under), returning the update command. The library reads only
 * that version.
 */
export async function readUpdate(
  library: PinLibrary,
  partId: string,
  feature: DerivedFeature,
  version: Version,
): Promise<LibraryResult<{ command: Command; label: string }>> {
  const { source } = feature;
  const pinned = await readPin(library, source.documentId, version, source.partId, {
    documentName: source.documentName,
    ...(source.configuration !== undefined ? { configuration: source.configuration } : {}),
  });
  if (!pinned.ok) return pinned;
  return { ok: true, value: updatePin(partId, feature, pinned.value.source) };
}

/** What opening a source at its pinned version needs of the app. */
export interface OpenSourceHost {
  /** The open document's id. */
  currentId(): string;
  /** Open document `id` in the editor, saving the open one first. */
  open(id: string): Promise<{ ok: boolean; message: string }>;
  listVersions(id: string): Promise<LibraryResult<Version[]>>;
  /** Show `version` of the open document read-only (the version viewer). */
  view(version: Version): Promise<void> | void;
}

/**
 * Open a pin's source document and show it read-only at the pinned version (the version viewer,
 * whose Back leaves the source document open as it is now). Fails, opening nothing, when the
 * source or that version is not in this library.
 */
export async function openSourceAt(
  host: OpenSourceHost,
  source: Pick<DerivedSource, 'documentId' | 'documentName' | 'versionId' | 'versionName'>,
): Promise<LibraryResult<Version>> {
  try {
    const listed = await host.listVersions(source.documentId);
    const version = listed.ok ? listed.value.find((v) => v.id === source.versionId) : undefined;
    if (!version) {
      return {
        ok: false,
        message: `${source.documentName || 'The source'} at "${source.versionName}" is not in this browser's documents.`,
      };
    }
    if (host.currentId() !== source.documentId) {
      const opened = await host.open(source.documentId);
      if (!opened.ok) return { ok: false, message: opened.message };
    }
    await host.view(version);
    return { ok: true, value: version };
  } catch (e) {
    return failure(e);
  }
}
