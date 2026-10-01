// Pinned sources of derived parts as regen consumes them (core README, "Derived parts"). A
// derived feature stores the source document at a version as canonical JSON text, with its
// UTF-8 `size` and SHA-256. Before the source is built, regen checks the hash (once per source
// object, as `imports.ts` does for files), reads the document (migrating an older format in
// memory; a newer one is an error on the feature), finds the part, and checks that the chain of
// sources below it nests no deeper than `MAX_DERIVED_DEPTH`. Only then does the engine
// regenerate the part, in the same kernel, under a cache namespace of its own (`sourceNamespace`).
//
// A source is built in a configuration row of its document (T2.4c): the row the pin names
// (`source.configuration`), else the row the source document had active, as that document shows
// itself. A named row the source does not have, or one that cannot be applied, is an error on the
// feature or instance; an active row that cannot be applied leaves the document as it is, which is
// also what the source document's own app shows. The row is part of the namespace, so two rows of
// one pin are two builds with entries of their own.
//
// A pin is an immutable snapshot, so everything read from one source is read once: documents are
// kept by hash while regens use them, and the nesting height of each (hash, part) is memoized.

import {
  MAX_DERIVED_DEPTH,
  configurationRow,
  configured,
  deserialize,
  type BodyPropsFields,
  type ConfigRow,
  type DerivedFeature,
  type DerivedSource,
  type ManufaktureDocument,
  type Part,
} from '@manufakture/core';
import { sha256Hex } from './imports';
import type { RegenError } from './types';

export type OpenedSource =
  | {
      ok: true;
      /** The source document with its row applied (the document as stored when none is). */
      document: ManufaktureDocument;
      part: Part;
      /** The configuration row it is built in, or null for the document as it is. */
      row: ConfigRow | null;
      /** `sourceNamespace` of the source in that row. */
      namespace: string;
    }
  | { ok: false; error: RegenError & { code: 'source' } };

/**
 * The cache namespace of a source part in a configuration row (`null`: none): every derived
 * feature and instance of one pinned part in one row shares it.
 */
export function sourceNamespace(source: DerivedSource, row: string | null = null): string {
  const base = `${source.sha256}\n${source.partId}`;
  return row === null ? base : `${base}\n${row}`;
}

/** Whether `data` is `size` bytes of UTF-8 whose SHA-256 is `sha256`. */
export async function derivedSourceMatches(source: DerivedSource): Promise<boolean> {
  const bytes = new TextEncoder().encode(source.data);
  if (bytes.length !== source.size) return false;
  return (await sha256Hex(bytes)) === source.sha256;
}

/** The derived features of a part that a regen of it would build: before the bar, not suppressed. */
export function nestedDerived(part: Part): DerivedFeature[] {
  const bar = part.rollbackIndex ?? part.features.length;
  return part.features
    .slice(0, bar)
    .filter((f): f is DerivedFeature => f.kind === 'derived' && !f.suppressed);
}

const describe = (s: DerivedSource) =>
  `${s.documentName || s.documentId} at ${s.versionName || s.versionId}`;

/** Where a source is, for messages: the document, the version and the row it is built in. */
export function describeSource(source: DerivedSource, row: ConfigRow | null): string {
  return row === null ? describe(source) : `${describe(source)} in configuration ${row.name}`;
}

/**
 * The name, colour and material a body shows in its part: its own settings, else what it
 * inherited from a source, else (for the material) the part's.
 */
export function effectiveProps(
  part: Part,
  bodyId: string,
  inherited: BodyPropsFields | undefined,
): BodyPropsFields {
  const own = part.bodies.find((b) => b.id === bodyId);
  const out: BodyPropsFields = {};
  const name = own?.name ?? inherited?.name;
  const color = own?.color ?? inherited?.color;
  const material = own?.material ?? inherited?.material ?? part.material;
  if (name !== undefined) out.name = name;
  if (color !== undefined) out.color = color;
  if (material !== undefined) out.material = material;
  return out;
}

/** What carries over to a body from its source: the fields `part` does not set for it. */
export function carriedProps(
  part: Part,
  bodyId: string,
  inherited: BodyPropsFields | undefined,
): BodyPropsFields | undefined {
  if (inherited === undefined) return undefined;
  const own = part.bodies.find((b) => b.id === bodyId);
  const out: BodyPropsFields = {};
  if (inherited.name !== undefined && own?.name === undefined) out.name = inherited.name;
  if (inherited.color !== undefined && own?.color === undefined) out.color = inherited.color;
  if (inherited.material !== undefined && own?.material === undefined) {
    out.material = inherited.material;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Opens pinned sources for one engine; see the file comment. */
export class DerivedSources {
  /** Source objects whose hash was checked, and the outcome. */
  readonly #checked = new WeakMap<DerivedSource, boolean>();
  /** Read documents by hash (or why they cannot be read), kept while regens use them. */
  #documents = new Map<string, OpenedDocument>();
  /** Source documents with a row applied, by hash and row id (or why the row cannot be). */
  #configured = new Map<string, ConfiguredDocument>();
  /** How many levels of sources a (hash, part) is, itself included, when fully known. */
  #heights = new Map<string, number>();
  #used = new Set<string>();

  /** Start of a regen: what it opens is what `retain` keeps. */
  begin(): void {
    this.#used = new Set();
  }

  /** After a completed regen: forget the documents it did not open. */
  retain(): void {
    for (const sha of this.#documents.keys()) {
      if (!this.#used.has(sha)) this.#documents.delete(sha);
    }
    for (const map of [this.#heights, this.#configured]) {
      for (const key of map.keys()) {
        if (!this.#used.has(key.slice(0, key.indexOf('\n')))) map.delete(key);
      }
    }
  }

  /** Check, read and find the part of a pinned source. */
  async open(source: DerivedSource): Promise<OpenedSource> {
    let matches = this.#checked.get(source);
    if (matches === undefined) {
      matches = await derivedSourceMatches(source);
      this.#checked.set(source, matches);
    }
    if (!matches) {
      return fail(
        ['source', 'sha256'],
        `The stored copy of ${describe(source)} does not match its SHA-256: the document is damaged; update the derived part or insert it again`,
      );
    }
    this.#used.add(source.sha256);
    let doc = this.#documents.get(source.sha256);
    if (doc === undefined) {
      doc = read(source.data);
      this.#documents.set(source.sha256, doc);
    }
    if (!doc.ok) {
      return fail(
        ['source', 'data'],
        doc.newer
          ? `${describe(source)} was saved by a newer version of manufakture (${doc.message.replace(/^[^(]*\(|\).*$/g, '')}); update the app to build it`
          : `${describe(source)} cannot be read: ${doc.message}`,
      );
    }
    const rowed = this.#inRow(source, doc.document);
    if (!rowed.ok) return fail(['source', 'configuration'], rowed.message);
    const { document, row } = rowed;
    const part = document.parts.find((p) => p.id === source.partId);
    if (part === undefined) {
      return fail(
        ['source', 'partId'],
        `${describe(source)} has no part ${source.partId}; pick another part`,
      );
    }
    return {
      ok: true,
      document,
      part,
      row,
      namespace: sourceNamespace(source, row === null ? null : row.id),
    };
  }

  /** The source document in the row it is built in (see the file comment). */
  #inRow(
    source: DerivedSource,
    base: ManufaktureDocument,
  ):
    | { ok: true; document: ManufaktureDocument; row: ConfigRow | null }
    | { ok: false; message: string } {
    const named = source.configuration;
    const id = named ?? base.configurations?.active ?? null;
    if (id === null) return { ok: true, document: base, row: null };
    const key = `${source.sha256}\n${id}`;
    let got = this.#configured.get(key);
    if (got === undefined) {
      const row = configurationRow(base, id);
      const r = row === undefined ? undefined : configured(base, id);
      got =
        row === undefined
          ? { ok: false, missing: true, message: '' }
          : r!.ok
            ? { ok: true, document: r!.value, row }
            : { ok: false, missing: false, message: r!.error.message };
      this.#configured.set(key, got);
    }
    if (got.ok) return got;
    // The row the source had active, which its own app could not apply either: as it is.
    if (named === undefined) return { ok: true, document: base, row: null };
    if (got.missing) {
      return {
        ok: false,
        message: `${describe(source)} has no configuration row ${id}; pick another row`,
      };
    }
    const name = configurationRow(base, id)?.name ?? id;
    return {
      ok: false,
      message: `Configuration ${name} (${id}) of ${describe(source)} cannot be applied: ${got.message}`,
    };
  }

  /**
   * Whether a source opened at `depth` (1 for a derived feature of the document being
   * regenerated, 2 for one inside its source, ...) keeps every source below it within
   * `MAX_DERIVED_DEPTH`. Descends at most that deep, opening each source on the way, and never
   * builds anything. A source that cannot be opened counts as one level: it fails on its own.
   */
  async fits(source: DerivedSource, depth: number): Promise<boolean> {
    const budget = MAX_DERIVED_DEPTH - depth + 1;
    return (await this.#height(source, budget)) <= budget;
  }

  /** The height of a source (1 with no derived features below it), or Infinity above `budget`. */
  async #height(source: DerivedSource, budget: number): Promise<number> {
    if (budget <= 0) return Infinity;
    const opened = await this.open(source);
    if (!opened.ok) return 1;
    // In its row: a row can unsuppress a derived feature, or suppress one.
    const key = opened.namespace;
    const known = this.#heights.get(key);
    if (known !== undefined) return known > budget ? Infinity : known;
    let height = 1;
    for (const f of nestedDerived(opened.part)) {
      const below = await this.#height(f.source, budget - 1);
      if (below === Infinity) return Infinity;
      height = Math.max(height, 1 + below);
    }
    this.#heights.set(key, height);
    return height;
  }
}

type ConfiguredDocument =
  | { ok: true; document: ManufaktureDocument; row: ConfigRow }
  | { ok: false; missing: boolean; message: string };

type OpenedDocument =
  { ok: true; document: ManufaktureDocument } | { ok: false; newer: boolean; message: string };

function read(data: string): OpenedDocument {
  // A pin is data from elsewhere: whatever reading it throws (a migration meeting a shape it
  // does not expect) is an error on the feature, never a failed regen.
  let loaded: ReturnType<typeof deserialize>;
  try {
    loaded = deserialize(data);
  } catch (error) {
    return {
      ok: false,
      newer: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!loaded.ok) {
    const newer = loaded.error.code === 'version' && /newer/.test(loaded.error.message);
    return { ok: false, newer, message: loaded.error.message };
  }
  return { ok: true, document: loaded.value.document };
}

function fail(field: readonly string[], message: string): OpenedSource {
  return { ok: false, error: { code: 'source', field, message } };
}

/** The depth error: the source nests deeper than regen builds. */
export function tooDeep(source: DerivedSource): RegenError {
  return {
    code: 'source',
    field: ['source'],
    message: `${describe(source)} nests derived parts more than ${MAX_DERIVED_DEPTH} deep; nothing of it was built`,
  };
}
