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

/** File format migrations, in order: `FORMAT_MIGRATIONS[i]` goes from version i to i + 1. */
export const FORMAT_MIGRATIONS: readonly Migration[] = [migrateV0ToV1, migrateV1ToV2];

/**
 * Naming scheme migrations (T0.5): rewrite stored face and edge names when the naming scheme
 * changes, independently of the file shape. There are none yet; scheme 1 is the first.
 * `NAMING_MIGRATIONS[i]` goes from scheme i + 1 to i + 2.
 */
export const NAMING_MIGRATIONS: readonly Migration[] = [];
