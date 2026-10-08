// One walk over the plain JSON a document or a command is: arrays and plain objects, depth first,
// every other value a leaf. Two uses share it: finding things (`visitJson`, which hands each
// object a context its members inherit and copies nothing) and rewriting them (`mapJson`, which
// rebuilds the tree bottom up). The blob storage form (blobs.ts) maps sources in and out of
// documents and commands with it, and the app finds the import features undo can bring back
// (src/io/restorable.ts) by visiting them.

export type JsonObject = Record<string, unknown>;

export const isJsonObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** How deep a walk goes. The value passed in is depth 0; each array or object adds one. */
export interface DepthLimit {
  /** The deepest value walked. */
  maxDepth: number;
  /**
   * Past `maxDepth`: when set, the walk throws an `Error` with this message; when unset, the
   * deeper value is left alone (not visited, and kept as it is by a map).
   */
  tooDeep?: string;
}

/**
 * The walk itself. `enter` sees each object before its members and gives the context they get;
 * `leave`, when given, makes the walk rebuild: it gets each object's copy (members already
 * mapped) with the original and returns what replaces it. Own `__proto__` keys (JSON.parse makes
 * them) are never walked, and a rebuilt object leaves them out: assigning one would set the
 * copy's prototype, and no document or command has one.
 */
function walk<C>(
  value: unknown,
  context: C,
  depth: number,
  limit: DepthLimit,
  enter: ((o: JsonObject, context: C) => C) | undefined,
  leave: ((copy: JsonObject, original: JsonObject) => JsonObject) | undefined,
): unknown {
  if (depth > limit.maxDepth) {
    if (limit.tooDeep !== undefined) throw new Error(limit.tooDeep);
    return value;
  }
  if (Array.isArray(value)) {
    if (leave) return value.map((v) => walk(v, context, depth + 1, limit, enter, leave));
    for (const v of value) walk(v, context, depth + 1, limit, enter, leave);
    return value;
  }
  if (!isJsonObject(value)) return value;
  const inner = enter ? enter(value, context) : context;
  if (!leave) {
    for (const [k, v] of Object.entries(value)) {
      if (k !== '__proto__') walk(v, inner, depth + 1, limit, enter, leave);
    }
    return value;
  }
  const copy: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== '__proto__') copy[k] = walk(v, inner, depth + 1, limit, enter, leave);
  }
  return leave(copy, value);
}

/**
 * Call `enter` on every plain object in `value`, parents before their members. What `enter`
 * returns is the context the object's members get; arrays pass theirs on unchanged. Copies
 * nothing.
 */
export function visitJson<C>(
  value: unknown,
  context: C,
  enter: (o: JsonObject, context: C) => C,
  limit: DepthLimit,
): void {
  walk(value, context, 0, limit, enter, undefined);
}

/**
 * A copy of `value` with every plain object replaced by what `leave` returns for it, members
 * first: `leave` gets the object's copy, its members already mapped, and the original.
 */
export function mapJson(
  value: unknown,
  leave: (copy: JsonObject, original: JsonObject) => JsonObject,
  limit: DepthLimit,
): unknown {
  return walk(value, undefined, 0, limit, undefined, leave);
}
