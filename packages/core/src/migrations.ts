/**
 * The migration chains. A migration is a pure function from the JSON of one version to the JSON
 * of the next; it gets its own copy of the data and may change it in place. The chain is applied
 * in order on load, and each migration is tested against a fixture of the older version.
 *
 * To change the file shape: bump `FORMAT_VERSION` in `schema.ts`, append a migration here, add a
 * fixture of the old version under `fixtures/`, and extend the migration test. Commands carry
 * parts of the document shape too (a feature, a whole part, a whole document), so append the
 * matching command migration to `COMMAND_MIGRATIONS` as well (see there).
 */

import { CommandSchema, type Command } from './commands';
import { fail, ok, schemaError, type CoreResult } from './result';
import { FORMAT_VERSION } from './schema';

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

/**
 * Version 14 added CAM (ADR 0014 decisions 2 and 14, M5 T5.1b). A version 13 document has none,
 * so it gets an empty CAM section, `cam: { tools: [], setups: [], nextIds: {} }`, right after
 * `fonts` as in a freshly saved file; nothing else changes, and every CAM counter starts at 1.
 */
export const migrateV13ToV14: Migration = {
  from: 13,
  to: 14,
  description: 'Add CAM tools and setups',
  migrate(doc) {
    // Version 13 had no such key: refuse rather than drop or keep it (nothing is repaired).
    if ('cam' in doc) throw new Error('a version 13 document has no "cam" section');
    const empty = () => ({ tools: [], setups: [], nextIds: {} });
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(doc)) {
      out[k] = k === 'version' ? 14 : v;
      if (k === 'fonts') out.cam = empty();
    }
    if (!('cam' in out)) out.cam = empty();
    return out;
  },
};

/**
 * Version 15 added the domain view source (`{ domain, part, schemaVersion, params }`, M6 plan
 * T6.4a: construction floor plans and framing elevations, ADR 0015 decision 9). Nothing in a
 * version 14 file changes: its views all show a part or an assembly.
 */
export const migrateV14ToV15: Migration = {
  from: 14,
  to: 15,
  description: 'Add domain view sources',
  migrate(doc) {
    return { ...doc, version: 15 };
  },
};

/**
 * Version 16 added the script library (`scripts`, absent when empty) and the `scripted` feature
 * kind (ADR 0010 decision 8, M7 plan T7.2a), with the document counter `script`. Nothing in a
 * version 15 file changes: it has no scripts, which is what an absent `scripts` means. A version
 * 15 file that already has a `scripts` key is refused rather than read as a library.
 */
export const migrateV15ToV16: Migration = {
  from: 15,
  to: 16,
  description: 'Add the script library and scripted features',
  migrate(doc) {
    if ('scripts' in doc) throw new Error('a version 15 document has no "scripts" library');
    return { ...doc, version: 16 };
  },
};

/**
 * Version 17 added body groups (the optional `bodyGroups` of a part, with the part counter
 * `group`). Nothing in a version 16 file changes: its parts have no groups, which is what an
 * absent `bodyGroups` means. A version 16 part that already has a `bodyGroups` key is refused
 * rather than read as groups.
 */
export const migrateV16ToV17: Migration = {
  from: 16,
  to: 17,
  description: 'Add body groups',
  migrate(doc) {
    const parts = Array.isArray(doc.parts) ? doc.parts : [];
    if (parts.some((p) => isObject(p) && 'bodyGroups' in p)) {
      throw new Error('a version 16 part has no "bodyGroups"');
    }
    return { ...doc, version: 17 };
  },
};

/**
 * Version 18 added two optional fields to the hole feature: a blind extent's `tipAngle` (180 deg
 * for a flat bottom) and the insert standard (`standard: { size, purpose: 'heat-set-insert' }`).
 * Nothing in a version 17 file changes: its blind holes end in the default drill point, which is
 * what an absent `tipAngle` means, and its standards are clearance standards. A version 17 hole
 * that already has a `tipAngle` or a `standard.purpose` is refused rather than read.
 */
export const migrateV17ToV18: Migration = {
  from: 17,
  to: 18,
  description: 'Add hole tip angles and heat-set insert holes',
  migrate(doc) {
    const parts = Array.isArray(doc.parts) ? doc.parts : [];
    for (const part of parts) {
      const features = isObject(part) && Array.isArray(part.features) ? part.features : [];
      for (const f of features) {
        if (!isObject(f) || f.kind !== 'hole') continue;
        if (isObject(f.extent) && 'tipAngle' in f.extent) {
          throw new Error('a version 17 hole has no "tipAngle"');
        }
        if (isObject(f.standard) && 'purpose' in f.standard) {
          throw new Error('a version 17 hole standard has no "purpose"');
        }
      }
    }
    return { ...doc, version: 18 };
  },
};

/**
 * Version 19 added the mechanical domain's shapes (ADR 0017, M9 plan T9.1e) in one step: the
 * optional `mech` section, user materials (`materials`, with the document counter `material`, and
 * `Part.material` and a body's `material` naming them) and per-kind display units
 * (`units.quantities`). Nothing in a version 18 file changes: it has no mechanical section, no
 * user materials and no display units per kind, which is what their absence means. A version 18
 * file that already has a `mech` or `materials` key, or a `units.quantities`, is refused rather
 * than read.
 */
export const migrateV18ToV19: Migration = {
  from: 18,
  to: 19,
  description: 'Add the mechanical section, user materials and display units per kind',
  migrate(doc) {
    if ('mech' in doc) throw new Error('a version 18 document has no "mech" section');
    if ('materials' in doc) throw new Error('a version 18 document has no "materials"');
    if (isObject(doc.units) && 'quantities' in doc.units) {
      throw new Error('a version 18 document has no "units.quantities"');
    }
    return { ...doc, version: 19 };
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
  migrateV13ToV14,
  migrateV14ToV15,
  migrateV15ToV16,
  migrateV16ToV17,
  migrateV17ToV18,
  migrateV18ToV19,
];

/**
 * Naming scheme migrations (T0.5): rewrite stored face and edge names when the naming scheme
 * changes, independently of the file shape. There are none yet; scheme 1 is the first.
 * `NAMING_MIGRATIONS[i]` goes from scheme i + 1 to i + 2.
 */
export const NAMING_MIGRATIONS: readonly Migration[] = [];

// Command migrations ---------------------------------------------------------------------------

/**
 * A command migration: from the JSON of a command written under document format `from` to the
 * same command under `to`. Like document migrations it gets its own copy and may change it.
 */
export interface CommandMigration {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  readonly migrate: (command: JsonObject) => JsonObject;
}

/**
 * The command step beside document migration `document`: applies it to the document a
 * `replaceDocument` carries, recurses into batches, and gives every other command to `entities`,
 * which migrates the parts of the document shape that command carries (a feature, a part).
 */
function commandStep(
  document: Migration,
  entities: (command: JsonObject) => JsonObject = (c) => c,
): CommandMigration {
  const migrate = (command: JsonObject): JsonObject => {
    if (command.type === 'batch' && Array.isArray(command.commands)) {
      return {
        ...command,
        commands: command.commands.map((c) => (isObject(c) ? migrate(c) : c)),
      };
    }
    if (command.type === 'replaceDocument' && isObject(command.document)) {
      return { ...command, document: document.migrate(command.document) };
    }
    return entities(command);
  };
  return { from: document.from, to: document.to, description: document.description, migrate };
}

/** Version 0 to 1 for a feature: the `suppressed` flag (absent was not suppressed). */
function suppressible(feature: unknown): unknown {
  return isObject(feature) ? { suppressed: false, ...feature } : feature;
}

/** Version 0 to 1 for the commands that carry features or parts. */
function commandV0ToV1(command: JsonObject): JsonObject {
  if (
    command.type === 'addFeature' ||
    command.type === 'editFeature' ||
    command.type === 'restoreFeature'
  ) {
    return { ...command, feature: suppressible(command.feature) };
  }
  if (command.type === 'restorePart' && isObject(command.part)) {
    const part = command.part;
    return {
      ...command,
      part: {
        ...part,
        features: Array.isArray(part.features) ? part.features.map(suppressible) : part.features,
        rollbackIndex: part.rollbackIndex ?? null,
      },
    };
  }
  return command;
}

/** Version 3 to 4 for a restored part: body props (`bodies: []`, none set). */
function commandV3ToV4(command: JsonObject): JsonObject {
  if (command.type === 'restorePart' && isObject(command.part) && !('bodies' in command.part)) {
    return { ...command, part: { ...command.part, bodies: [] } };
  }
  return command;
}

/**
 * Command migrations, in order: `COMMAND_MIGRATIONS[i]` goes from format i to i + 1, beside
 * `FORMAT_MIGRATIONS[i]` (a test keeps the two lists in step). Log entries and persisted sync
 * queues store commands as written, with their format, and `migrateCommand` brings them up to
 * date before they are applied (ADR 0009, consequences).
 *
 * A format task appends one entry here: `commandStep(itsMigration)` when no command carries the
 * changed shape except inside a whole document, or with an `entities` function that migrates the
 * feature, part, assembly or other item the affected commands carry. A command whose meaning
 * changes is not migrated: it becomes a new command type (M7 plan, cross-cutting decision 3).
 */
export const COMMAND_MIGRATIONS: readonly CommandMigration[] = [
  commandStep(migrateV0ToV1, commandV0ToV1),
  commandStep(migrateV1ToV2),
  commandStep(migrateV2ToV3),
  commandStep(migrateV3ToV4, commandV3ToV4),
  commandStep(migrateV4ToV5),
  commandStep(migrateV5ToV6),
  commandStep(migrateV6ToV7),
  commandStep(migrateV7ToV8),
  commandStep(migrateV8ToV9),
  commandStep(migrateV9ToV10),
  commandStep(migrateV10ToV11),
  commandStep(migrateV11ToV12),
  commandStep(migrateV12ToV13),
  commandStep(migrateV13ToV14),
  commandStep(migrateV14ToV15),
  commandStep(migrateV15ToV16),
  commandStep(migrateV16ToV17),
  commandStep(migrateV17ToV18),
  commandStep(migrateV18ToV19),
];

export interface CommandMigrationOptions {
  /** Target format (default `FORMAT_VERSION`); for tests. */
  readonly formatVersion?: number;
  /** The chain (default `COMMAND_MIGRATIONS`); for tests. */
  readonly commandMigrations?: readonly CommandMigration[];
}

/**
 * Brings a command written under document format `fromFormat` up to the current format and
 * validates it against `CommandSchema`. Refuses a format newer than this build reads, like a
 * document. The input is not changed.
 */
export function migrateCommand(
  command: unknown,
  fromFormat: number,
  options: CommandMigrationOptions = {},
): CoreResult<Command> {
  const target = options.formatVersion ?? FORMAT_VERSION;
  const chain = options.commandMigrations ?? COMMAND_MIGRATIONS;
  if (!Number.isInteger(fromFormat) || fromFormat < 0) {
    return fail('version', "A command's format must be an integer of at least 0", ['format']);
  }
  if (fromFormat > target) {
    return fail(
      'version',
      `This command was written by a newer version of manufakture (file format ${fromFormat}; this app reads up to ${target}). It was not applied.`,
      ['format'],
    );
  }
  if (!isObject(command) || typeof command.type !== 'string') {
    return fail('schema', 'Invalid command: expected an object with a "type"', ['type']);
  }
  let current: JsonObject;
  try {
    current = JSON.parse(JSON.stringify(command)) as JsonObject;
  } catch (e) {
    return fail('schema', `Invalid command: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (let v = fromFormat; v < target; v++) {
    const m = chain[v];
    if (!m || m.from !== v || m.to !== v + 1) {
      return fail('migration', `No command migration from format ${v} to ${v + 1}`, ['format']);
    }
    try {
      current = m.migrate(current);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return fail('migration', `Command migration from format ${v} to ${v + 1} failed: ${why}`, [
        'format',
      ]);
    }
  }
  const parsed = CommandSchema.safeParse(current);
  if (!parsed.success) return { ok: false, error: schemaError('Invalid command', parsed.error) };
  return ok(parsed.data);
}
