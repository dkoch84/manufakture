// Sketch entity and constraint ids.
//
// Entity ids feed topological naming (`extrude#3:side:<entity-id>`, T0.5), so
// their syntax is restricted to what the naming layer can parse unambiguously:
//
//   base      [A-Za-z0-9_.-]+       e1, c12, line_3
//   split     (#[a-z]+)*            e2#a, e2#b, e2#a#b (a split of a split)
//
// `#<digits>` is reserved for positional kernel splits (`cut#4:side:s3#1`),
// which are fragile, so a sketch id must never contain it. The characters the
// naming layer uses as separators (`: | [ ] , + ( ) &`) and whitespace are
// rejected too.

const ID_PATTERN = /^[A-Za-z0-9_.-]+(?:#[a-z]+)*$/;

/** Whether `id` is a valid sketch entity or constraint id. */
export function isValidSketchId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Why `id` is not valid, or `null` when it is. */
export function sketchIdProblem(id: string): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'Id is empty';
  if (/#\d+$/.test(id)) {
    return `Id '${id}' ends in '#<digits>', which is reserved for positional kernel splits`;
  }
  if (/#\d/.test(id)) return `Id '${id}' contains '#<digits>', which is reserved for kernel splits`;
  if (!ID_PATTERN.test(id)) {
    return `Id '${id}' must be letters, digits, '_', '.' or '-', optionally followed by split suffixes like '#a'`;
  }
  return null;
}

/**
 * The suffix letters for the n-th piece of a split (0-based): a, b, ..., z,
 * aa, ab, ... (bijective base 26, so the order is also the sort order for
 * up to 26 pieces).
 */
export function splitSuffix(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`Bad split index ${index}`);
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Ids for the pieces of `id` split into `count` pieces, in order along the
 * original entity: `e2` gives `e2#a`, `e2#b`. Splitting a piece appends
 * another suffix: `e2#a` gives `e2#a#a`, `e2#a#b`.
 */
export function splitIds(id: string, count: number): string[] {
  const problem = sketchIdProblem(id);
  if (problem !== null) throw new Error(problem);
  if (!Number.isInteger(count) || count < 2)
    throw new RangeError('A split makes at least 2 pieces');
  return Array.from({ length: count }, (_, i) => `${id}#${splitSuffix(i)}`);
}

/** The id a split piece came from (`e2#a#b` gives `e2#a`), or `null` for an unsplit id. */
export function splitParent(id: string): string | null {
  const at = id.lastIndexOf('#');
  return at > 0 ? id.slice(0, at) : null;
}

/** Every id `id` descends from, nearest first: `e2#a#b` gives `['e2#a', 'e2']`. */
export function splitAncestors(id: string): string[] {
  const out: string[] = [];
  for (let parent = splitParent(id); parent !== null; parent = splitParent(parent)) {
    out.push(parent);
  }
  return out;
}
