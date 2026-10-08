// JSON Schemas of command types and feature kinds (the `get_schema` read tool, ADR 0016 decision
// 6): generated from core's zod schemas (`z.toJSONSchema`, input side), with the doc comments of
// `doc-comments.json` as descriptions.

import { FEATURE_KINDS, FeatureSchema, SimpleCommandSchema } from '@manufakture/core';
import { z } from 'zod';
import docs from './doc-comments.json' with { type: 'json' };
import type { DocEntry, DocTable } from './doc-comments';
import { done, sessionError, type SessionResult } from './errors';

type JsonSchema = Record<string, unknown>;

const TABLE = docs as DocTable;

const BATCH_DOC =
  'Several commands applied as one step, all or nothing: one revision, one label, one undo. ' +
  'A session applies every write as one batch.';

let commandSchemas: Map<string, JsonSchema> | null = null;
let featureSchemas: Map<string, JsonSchema> | null = null;

function toJson(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
    cycles: 'ref',
  }) as JsonSchema;
}

/** `schema` with `entry`'s comments as descriptions where zod has none. */
function described(schema: JsonSchema, entry: DocEntry | undefined): JsonSchema {
  if (entry === undefined) return schema;
  const out: JsonSchema = { ...schema };
  if (entry.doc !== undefined && out.description === undefined) out.description = entry.doc;
  const properties = out.properties as Record<string, JsonSchema> | undefined;
  if (properties !== undefined) {
    const copy: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      const doc = entry.fields[key];
      copy[key] =
        doc !== undefined && value.description === undefined
          ? { ...value, description: doc }
          : value;
    }
    out.properties = copy;
  }
  return out;
}

/** Each option of a discriminated union by its discriminator's constant. */
function byConstant(options: readonly z.ZodType[], key: string): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  for (const option of options) {
    const schema = toJson(option);
    const prop = (schema.properties as Record<string, { const?: unknown }> | undefined)?.[key];
    if (typeof prop?.const === 'string') out.set(prop.const, schema);
  }
  return out;
}

function commands(): Map<string, JsonSchema> {
  if (commandSchemas === null) {
    commandSchemas = byConstant(SimpleCommandSchema.options as readonly z.ZodType[], 'type');
    commandSchemas.set('batch', {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      description: BATCH_DOC,
      properties: {
        type: { type: 'string', const: 'batch' },
        commands: {
          type: 'array',
          description: 'The commands, in order: any command type (get_schema of each).',
          items: { type: 'object' },
        },
      },
      required: ['type', 'commands'],
      additionalProperties: false,
    });
  }
  return commandSchemas;
}

function features(): Map<string, JsonSchema> {
  featureSchemas ??= byConstant(FeatureSchema.options as readonly z.ZodType[], 'kind');
  return featureSchemas;
}

/** Every command type and feature kind a schema can be asked for. */
export function schemaIndex(): { commands: string[]; features: string[] } {
  return { commands: [...commands().keys()].sort(), features: [...FEATURE_KINDS] };
}

/** The JSON Schema of a command type (`{ command: 'addFeature' }`) or a feature kind. */
export function schemaOf(query: {
  command?: unknown;
  feature?: unknown;
}): SessionResult<JsonSchema> {
  const { command, feature } = query;
  if (typeof command === 'string' && feature === undefined) {
    const schema = commands().get(command);
    if (schema === undefined) {
      return sessionError('not-found', 'There is no such command type (see the schema index).');
    }
    return done(described(schema, TABLE.commands[command]));
  }
  if (typeof feature === 'string' && command === undefined) {
    const schema = features().get(feature);
    if (schema === undefined) {
      return sessionError('not-found', 'There is no such feature kind (see the schema index).');
    }
    return done(described(schema, TABLE.features[feature]));
  }
  return sessionError('invalid-input', 'Ask for one command type or one feature kind.');
}
