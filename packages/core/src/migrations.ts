/**
 * The migration chains. A migration is a pure function from the JSON of one version to the JSON
 * of the next; it gets its own copy of the data and may change it in place. The chain is applied
 * in order on load, and each migration is tested against a fixture of the older version.
 *
 * To change the file shape: bump `FORMAT_VERSION` in `schema.ts`, append a migration here, add a
 * fixture of the old version under `fixtures/`, and extend the migration test.
 */

export type JsonObject = { [key: string]: unknown };

export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  readonly migrate: (doc: JsonObject) => JsonObject;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Version 0 was the pre-release draft of the format. It had no `namingScheme` (it was always
 * scheme 1), its features had no `suppressed` flag and its parts had no rollback bar. The
 * migration exists mainly so the mechanism is exercised from the first release on.
 */
export const migrateV0ToV1: Migration = {
  from: 0,
  to: 1,
  description: 'Add namingScheme, feature suppression and the rollback bar',
  migrate(doc) {
    const parts = Array.isArray(doc.parts) ? doc.parts : [];
    const out: JsonObject = {};
    // Rebuild in the current key order so migrated files read like freshly saved ones.
    out.format = doc.format;
    out.version = 1;
    out.namingScheme = doc.namingScheme ?? 1;
    for (const [k, v] of Object.entries(doc)) {
      if (!(k in out) && k !== 'parts') out[k] = v;
    }
    out.parts = parts.map((part) => {
      if (!isObject(part)) return part;
      const features = part.features;
      return {
        ...part,
        features: Array.isArray(features)
          ? features.map((f) => (isObject(f) ? { suppressed: false, ...f } : f))
          : features,
        rollbackIndex: part.rollbackIndex ?? null,
      };
    });
    return out;
  },
};

/**
 * Version 2 added the optional per-part `material`. Nothing in a version 1 file changes: it has
 * no material, which is what an absent `material` means.
 */
export const migrateV1ToV2: Migration = {
  from: 1,
  to: 2,
  description: 'Add the optional part material',
  migrate(doc) {
    return { ...doc, version: 2 };
  },
};

/**
 * Version 3 added the `import` feature kind (imported STEP and STL files, kept in the document).
 * Nothing in a version 2 file changes: it has no imports.
 */
export const migrateV2ToV3: Migration = {
  from: 2,
  to: 3,
  description: 'Add the import feature kind',
  migrate(doc) {
    return { ...doc, version: 3 };
  },
};

/**
 * Version 4 added bodies: per-body props (`Part.bodies`), an optional `scope` on features with an
 * operation, and the document's own `nextIds` for part ids. Every part gets `bodies: []`, and
 * `nextIds.part` starts past the highest `part#n` in the file (at 1 when there is none). Features
 * are unchanged: an absent `scope` means every body, which is what the version 3 compound did,
 * so a part with several `new` solids regenerates the same bodies.
 */
export const migrateV3ToV4: Migration = {
  from: 3,
  to: 4,
  description: 'Add body props, feature scopes and the document part counter',
  migrate(doc) {
    const parts = Array.isArray(doc.parts) ? doc.parts : [];
    let highest = 0;
    for (const part of parts) {
      const m =
        isObject(part) && typeof part.id === 'string' ? /^part#([1-9][0-9]*)$/.exec(part.id) : null;
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    return {
      ...doc,
      version: 4,
      parts: parts.map((part) => (isObject(part) ? { ...part, bodies: [] } : part)),
      nextIds: { part: highest + 1 },
    };
  },
};

/**
 * Version 5 added the optional configuration table (`configurations`) and its id counters
 * (`nextIds.cp`, `nextIds.cfg`). Nothing in a version 4 file changes: it has no table, which is
 * what an absent `configurations` means, and a counter that is absent starts at 1.
 */
export const migrateV4ToV5: Migration = {
  from: 4,
  to: 5,
  description: 'Add the configuration table',
  migrate(doc) {
    return { ...doc, version: 5 };
  },
};

/**
 * Version 6 added the `derived` feature kind (bodies of a pinned version of a part, carried in
 * the document) and the optional `mode` of a pattern or mirror of bodies. Nothing in a version 5
 * file changes: it has no derived features, and an absent `mode` is `add`, which is what a body
 * pattern did before.
 */
export const migrateV5ToV6: Migration = {
  from: 5,
  to: 6,
  description: 'Add the derived feature kind and the body pattern mode',
  migrate(doc) {
    return { ...doc, version: 6 };
  },
};

/**
 * Version 7 added assemblies (instances of parts, mates and mate connectors) and the vertex
 * reference connectors use. A version 6 document has none, so it gets `assemblies: []`, right
 * after `parts` as in a freshly saved file; nothing else changes, and an absent `assembly`
 * counter starts at 1.
 */
export const migrateV6ToV7: Migration = {
  from: 6,
  to: 7,
  description: 'Add assemblies',
  migrate(doc) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'assemblies') continue;
      out[k] = k === 'version' ? 7 : v;
      if (k === 'parts') out.assemblies = [];
    }
    if (!('assemblies' in out)) out.assemblies = [];
    return out;
  },
};

/**
 * Version 8 added print setups (ADR 0012 decision 1). A version 7 document has none, so it gets
 * an empty print section, `print: { setups: [], nextIds: {} }`, right after `assemblies` as in a
 * freshly saved file; nothing else changes, and every print counter starts at 1.
 */
export const migrateV7ToV8: Migration = {
  from: 7,
  to: 8,
  description: 'Add print setups',
  migrate(doc) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'print') continue;
      out[k] = k === 'version' ? 8 : v;
      if (k === 'assemblies') out.print = { setups: [], nextIds: {} };
    }
    if (!('print' in out)) out.print = { setups: [], nextIds: {} };
    return out;
  },
};

/**
 * Version 9 added fonts and the `outline` sketch entity (ADR 0012 decisions 7 and 8). A version 8
 * document has neither, so it gets an empty font list, `fonts: []`, right after `print` as in a
 * freshly saved file; nothing else changes, and the font counter starts at 1.
 */
export const migrateV8ToV9: Migration = {
  from: 8,
  to: 9,
  description: 'Add fonts',
  migrate(doc) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'fonts') continue;
      out[k] = k === 'version' ? 9 : v;
      if (k === 'print') out.fonts = [];
    }
    if (!('fonts' in out)) out.fonts = [];
    return out;
  },
};

/**
 * Version 10 added the `thread` feature kind (ADR 0012 decision 9). Nothing in a version 9 file
 * changes: it has no threads.
 */
export const migrateV9ToV10: Migration = {
  from: 9,
  to: 10,
  description: 'Add the thread feature kind',
  migrate(doc) {
    return { ...doc, version: 10 };
  },
};

/**
 * Version 11 let extension features make and change bodies (optional `operation` and `scope`)
 * and added the optional document-level `domains` (ADR 0013 decisions 3 and 6). Nothing in a
 * version 10 file changes: its extensions have neither field and it has no domain data.
 */
export const migrateV10ToV11: Migration = {
  from: 10,
  to: 11,
  description: 'Let extensions make bodies; add domain data',
  migrate(doc) {
    return { ...doc, version: 11 };
  },
};

/**
 * Version 12 added drawings (the optional document-level `drawings`) and exploded views (the
 * optional `explodedViews` of an assembly), M4 plan decisions 7 and 9. Nothing in a version 11
 * file changes: it has neither.
 */
export const migrateV11ToV12: Migration = {
  from: 11,
  to: 12,
  description: 'Add drawings and exploded views',
  migrate(doc) {
    return { ...doc, version: 12 };
  },
};

/**
 * Version 13 added the `svg` source of the `outline` sketch entity (ADR 0012 decision 7, M5
 * T5.8): SVG artwork stored as paths. Nothing in a version 12 file changes: its outlines are text.
 */
export const migrateV12ToV13: Migration = {
  from: 12,
  to: 13,
  description: 'Add SVG outline sources',
  migrate(doc) {
    return { ...doc, version: 13 };
  },
};

/** File format migrations, in order: `FORMAT_MIGRATIONS[i]` goes from version i to i + 1. */
export const FORMAT_MIGRATIONS: readonly Migration[] = [
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
  migrateV9ToV10,
  migrateV10ToV11,
  migrateV11ToV12,
  migrateV12ToV13,
];

/**
 * Naming scheme migrations (T0.5): rewrite stored face and edge names when the naming scheme
 * changes, independently of the file shape. There are none yet; scheme 1 is the first.
 * `NAMING_MIGRATIONS[i]` goes from scheme i + 1 to i + 2.
 */
export const NAMING_MIGRATIONS: readonly Migration[] = [];
