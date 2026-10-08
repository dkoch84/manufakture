// Doc comments of core's commands and feature kinds, for `get_schema` (ADR 0016 decision 6:
// "JSON Schema ... from core's zod schemas, with doc comments"). Comments are not in the zod
// schemas at run time, so they are read from core's sources here and kept in
// `doc-comments.json`; `doc-comments.test.ts` fails when the sources say something else (rerun
// it with `-u` after a deliberate change). A session never reads sources at run time, so a
// bundled host has the comments too.

/** One command type's or feature kind's comments: its own, and its fields'. */
export interface DocEntry {
  doc?: string;
  fields: Record<string, string>;
}

export interface DocTable {
  commands: Record<string, DocEntry>;
  features: Record<string, DocEntry>;
}

/** A doc comment's text, on one line. */
function clean(comment: string): string {
  return comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The index just past the bracket matching the one at `open`, skipping strings and comments. */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === '}' || c === ')' || c === ']') {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** The doc comment that ends right before `at` (whitespace between), if any. */
function commentBefore(src: string, at: number): string | undefined {
  const before = src.slice(0, at).trimEnd();
  if (!before.endsWith('*/')) return undefined;
  const start = before.lastIndexOf('/**');
  if (start < 0) return undefined;
  const text = clean(before.slice(start));
  return text.length > 0 ? text : undefined;
}

/** The doc comments of the top-level fields of the object literal `body` (with its braces). */
function fieldDocs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const field = /\/\*\*([\s\S]*?)\*\/\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:,?]/g;
  for (let m = field.exec(body); m !== null; m = field.exec(body)) {
    // Top level only: the comment must sit at depth 1 (inside the object's own braces).
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      const c = body[i];
      if (c === '/' && body[i + 1] === '*') {
        i = body.indexOf('*/', i + 2) + 1;
        continue;
      }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
    }
    if (depth === 1) out[m[2]!] = clean(`/**${m[1]}*/`);
  }
  return out;
}

/**
 * The comments of every command type in core's `commands.ts` (each `z.strictObject({ type:
 * z.literal('...') ... })` of `SimpleCommandSchema`) and of every feature kind in `schema.ts`
 * (each `export const ...FeatureSchema`).
 */
export function extractDocComments(commandsSource: string, schemaSource: string): DocTable {
  const commands: Record<string, DocEntry> = {};
  const start = commandsSource.indexOf('export const SimpleCommandSchema');
  const union = commandsSource.slice(
    start,
    matching(commandsSource, commandsSource.indexOf('[', start)),
  );
  const command = /z\s*\.strictObject\(\{\s*type: z\.literal\('([A-Za-z]+)'\)/g;
  for (let m = command.exec(union); m !== null; m = command.exec(union)) {
    const open = union.indexOf('{', m.index);
    const doc = commentBefore(union, m.index);
    commands[m[1]!] = {
      ...(doc === undefined ? {} : { doc }),
      fields: fieldDocs(union.slice(open, matching(union, open))),
    };
  }
  const features: Record<string, DocEntry> = {};
  const feature = /export const ([A-Za-z]+)FeatureSchema = z\b/g;
  for (let m = feature.exec(schemaSource); m !== null; m = feature.exec(schemaSource)) {
    const open = schemaSource.indexOf('strictObject({', m.index) + 'strictObject('.length;
    const body = schemaSource.slice(open, matching(schemaSource, open));
    const kind = /(?:base\('|kind: z\.literal\(')([A-Za-z]+)'/.exec(body)?.[1];
    if (kind === undefined) continue;
    const doc = commentBefore(schemaSource, m.index);
    features[kind] = { ...(doc === undefined ? {} : { doc }), fields: fieldDocs(body) };
  }
  return { commands, features };
}
