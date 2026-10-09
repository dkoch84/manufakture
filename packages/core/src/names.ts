import { FEATURE_KINDS } from './featureKinds';

/**
 * A parser and printer for face names: the grammar of `packages/kernel/src/naming.ts`, read
 * so that sync can rewrite the ids inside a name (ADR 0009 decision 5) and validation can find
 * the features a name depends on (`featureIdsInName`). Names are rewritten through this parse,
 * never by string replacement.
 *
 * The forms, and how they parse:
 *
 * | Form                                  | Example                                   |
 * | ------------------------------------- | ----------------------------------------- |
 * | born `<feature id>:<role>[:<tail>]`   | `extrude#1:cap:end`, `fillet#3:round:r1`  |
 * | a sub-id tail with split suffixes     | `extrude#1:side:e2#a`, `e2#a#b`           |
 * | a positional sub-id tail (region edge) | `extrude#1:side:e2#1`                    |
 * | a qualified sub-id tail (region cap)  | `extrude#1:cap:end:e5`, `cap:start:e2#a`  |
 * | a nested name as the tail             | `shell#5:offset:extrude#1:cap:end`        |
 * | kernel pieces, former region caps     | `X#2`, `(A+B)#2`, `extrude#1:cap:end#1`   |
 * | keyed pieces (a joint's split)        | `extension#1:cap:end{extension#11:groove:xmin}` |
 * | merges                                | `(A+B)`                                   |
 * | corners and edge-face lists           | `fillet#3:corner:A&B&C`, `fillet#3:round:A&B` |
 * | instance prefixes                     | `pattern#7:i2/X`, `mirror#8:image/X`      |
 * | imported faces                        | `import#9:face:4`                         |
 * | placeholders                          | `?face3`, `hole#2:?face3`                 |
 * | derived prefixes (M2 decision 6)      | `derived#1:from/X`, `X` opaque            |
 * | script operation prefixes (ADR 0010)  | `scripted#2:boss/cap:end`, `scripted#2:rnd/round:A&B` |
 * | edge names (display only)             | `A|B`, `A|B[C,D]#2`                       |
 *
 * The parse is flat: a list of parts that print back to the name exactly
 * (`printName(parseName(name)) === name` for every string). Structure that sync and validation
 * need is in the part kinds:
 *
 * - `feature`: a feature id that starts a born name, an instance prefix or a derived prefix (a
 *   known feature kind, `#n`, then `:`, not preceded by a letter, digit or `#`). Its `:` is in
 *   the following text part.
 * - `sub`: the tail of a born name when the whole tail is a sub-id (`e7`, `k2`, `r1`) with its
 *   split and positional suffixes (`e7#a#1` is `e7` with suffix `#a#1`), or the sub-id after
 *   one lower-case word that qualifies the role (`end:e5`: the end cap of the region whose loop
 *   has edge e5, where `end:` is text). `start#2`, `end`, `wall`, `root:3`, `4` and other tails
 *   are text.
 * - `source`: what follows `<id>:from/`, up to the end of that merge or corner member: a name
 *   in a derived part's source document, never read for ids.
 * - A scripted feature's operation prefix, `<scripted id>:<operation id>/` (ADR 0010 decision
 *   6), is the feature part and then the text `:<operation id>/`; what follows is parsed on as
 *   any other text, so the feature ids in member names after it (a fillet round in a script,
 *   `scripted#2:rnd/round:extrude#1:cap:end&extrude#1:side:e2`) are feature parts, while the
 *   script's own roles and local ids (`cap:end`, `side:s1`) stay text and are never rewritten,
 *   even when a local id looks like a part sub-id (`side:e2`). An operation id is never read
 *   as a derived prefix, even `from`.
 * - `text`: everything else: roles, punctuation, opaque tails, placeholders, junk.
 *
 * A keyed piece `X{K}` (the piece of face X that a split left beside face K) is X, then the
 * text `{`, then K parsed as any name, then `}`: the ids in both X and K are found and rewritten.
 * Braces nest like brackets, so a derived source inside K ends at its `}`.
 *
 * It is one left-to-right pass with no recursion, linear in the length of the name, so no input
 * can exhaust the stack: unbalanced brackets are read as far as they go, a stray `)` at the top
 * level is text, and an unclosed `(` runs to the end. Nesting is not a tree here on purpose; a
 * corner `fillet#3:corner:A&B&C` reads as `fillet#3` with tail `A`, then `&B`, `&C`, which
 * rewrites and prints the same.
 */
export type NamePart =
  | { readonly kind: 'feature'; readonly id: string }
  | { readonly kind: 'sub'; readonly id: string; readonly suffix: string }
  | { readonly kind: 'source'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

const KIND_ALTERNATION = FEATURE_KINDS.join('|');
/** A feature id starting a name at this position, with its `:`. */
const HEAD = new RegExp(`(?:${KIND_ALTERNATION})#[1-9][0-9]*:`, 'y');
/** A whole tail that is a sub-id: base, then split letters, then positional pieces. */
const SUB_TAIL = /^([ekr][1-9][0-9]*)((?:#[a-z]+)*(?:#[1-9][0-9]*)*)$/;
/** A word that qualifies a role before a sub-id (`end` in `cap:end:e5`). */
const QUALIFIER = /^[a-z]+$/;
/** What follows `<id>:` when the rest of the member is a name in another document. */
const FROM = 'from/';
/** The kind of feature whose faces carry an operation prefix (`scripted#2:boss/`). */
const SCRIPTED = 'scripted#';
/** A script operation id and its `/`, after `scripted#n:` (ADR 0010 decision 6). */
const OPERATION = /[a-z][A-Za-z0-9_]*\//y;

function isIdChar(c: number): boolean {
  return (
    (c >= 48 && c <= 57) /* 0-9 */ ||
    (c >= 65 && c <= 90) /* A-Z */ ||
    (c >= 97 && c <= 122) /* a-z */ ||
    c === 35 /* # */
  );
}

/** Characters that end a role: the next field, a prefix, brackets and member separators. */
const ROLE_STOP = new Set([':', '/', '(', ')', '&', '+', '{', '}']);
/** Characters that end a sub-id candidate. */
const SUB_STOP = new Set([':', '/', '(', ')', '&', '+', '|', '[', ']', ',', '{', '}']);
/** Characters that may follow a sub-id tail. */
const SUB_END = new Set(['&', '+', ')', '|', '[', ']', ',', '{', '}']);

/** Parses a face name (or a body id, or an edge name). Total: every string parses. */
export function parseName(name: string): NamePart[] {
  const out: NamePart[] = [];
  let text = '';
  const flush = () => {
    if (text.length > 0) out.push({ kind: 'text', text });
    text = '';
  };
  const n = name.length;
  /** The length of a feature id head (with its `:`) at `i`, or 0. */
  const headAt = (i: number): number => {
    const c = name.charCodeAt(i);
    if (c < 97 || c > 122) return 0;
    if (i > 0 && isIdChar(name.charCodeAt(i - 1))) return 0;
    HEAD.lastIndex = i;
    const m = HEAD.exec(name);
    return m ? m[0].length : 0;
  };
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = name[i]!;
    if (c === '(' || c === '{') {
      depth++;
      text += c;
      i++;
      continue;
    }
    if (c === ')' || c === '}') {
      if (depth > 0) depth--;
      text += c;
      i++;
      continue;
    }
    const head = headAt(i);
    if (head === 0) {
      text += c;
      i++;
      continue;
    }
    flush();
    const id = name.slice(i, i + head - 1);
    out.push({ kind: 'feature', id });
    text = ':';
    i += head;
    if (id.startsWith(SCRIPTED)) {
      // A script operation prefix: the operation id is text, and what follows is a name of the
      // script's own (roles, local ids) with feature ids of member names in it, parsed on.
      OPERATION.lastIndex = i;
      const m = OPERATION.exec(name);
      if (m) {
        text += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (name.startsWith(FROM, i)) {
      // A derived prefix: the source name runs to the end of this member. Brackets and braces
      // inside it are skipped whole (an unclosed one runs to the end); a `)` or `}` that closes
      // an enclosing group or key ends it, a stray one at the top level does not.
      text += FROM;
      i += FROM.length;
      flush();
      let j = i;
      let local = 0;
      for (; j < n; j++) {
        const ch = name[j]!;
        if (ch === '(' || ch === '{') local++;
        else if (ch === ')' || ch === '}') {
          if (local > 0) local--;
          else if (depth > 0) break;
        } else if ((ch === '&' || ch === '+') && local === 0) break;
      }
      if (j > i) out.push({ kind: 'source', text: name.slice(i, j) });
      i = j;
      continue;
    }
    // The role: up to the next field, prefix, bracket, separator or feature id.
    let j = i;
    while (j < n && !ROLE_STOP.has(name[j]!) && headAt(j) === 0) j++;
    text += name.slice(i, j);
    i = j;
    if (name[i] === '/') {
      text += '/';
      i++;
    } else if (name[i] === ':') {
      text += ':';
      i++;
      let k = i;
      while (k < n && !SUB_STOP.has(name[k]!)) k++;
      const m = SUB_TAIL.exec(name.slice(i, k));
      if (m && (k === n || SUB_END.has(name[k]!))) {
        flush();
        out.push({ kind: 'sub', id: m[1]!, suffix: m[2]! });
        i = k;
      } else if (name[k] === ':' && QUALIFIER.test(name.slice(i, k))) {
        // `<role>:<qualifier>:<sub-id>` (`cap:end:e5`): the qualifier is text.
        let l = k + 1;
        while (l < n && !SUB_STOP.has(name[l]!)) l++;
        const q = SUB_TAIL.exec(name.slice(k + 1, l));
        if (q && (l === n || SUB_END.has(name[l]!))) {
          text += name.slice(i, k + 1);
          flush();
          out.push({ kind: 'sub', id: q[1]!, suffix: q[2]! });
          i = l;
        }
      }
    }
  }
  flush();
  return out;
}

/** Prints a parse back to the name. `printName(parseName(name)) === name` for every string. */
export function printName(parts: readonly NamePart[]): string {
  let out = '';
  for (const p of parts) {
    if (p.kind === 'feature') out += p.id;
    else if (p.kind === 'sub') out += p.id + p.suffix;
    else out += p.text;
  }
  return out;
}

/** How to rewrite the ids of a name. Both get the id alone (`extrude#1`, `e7` without suffix). */
export interface NameMaps {
  readonly feature?: (id: string) => string;
  readonly sub?: (id: string) => string;
}

/**
 * Rewrites the ids of a name: the feature ids of born names, merge and corner members and
 * instance prefixes, the sub-id tails (keeping split and positional suffixes), and of a derived
 * prefix only its own id, never the source name after it.
 */
export function mapName(name: string, maps: NameMaps): string {
  const parts = parseName(name);
  let changed = false;
  const out = parts.map((p): NamePart => {
    if (p.kind === 'feature' && maps.feature) {
      const id = maps.feature(p.id);
      if (id === p.id) return p;
      changed = true;
      return { kind: 'feature', id };
    }
    if (p.kind === 'sub' && maps.sub) {
      const id = maps.sub(p.id);
      if (id === p.id) return p;
      changed = true;
      return { kind: 'sub', id, suffix: p.suffix };
    }
    return p;
  });
  return changed ? printName(out) : name;
}

/**
 * Feature ids that a face name mentions, in order of appearance, without duplicates: the
 * `feature` parts of its parse (`parseName`). Names nest (merges `(A+B)`, corners
 * `fillet#3:corner:A&B&C`, copies `pattern#2:i3/A`), so every feature id starting a name counts,
 * not only the first; but in each merge or corner member, what follows `<id>:from/` is a name in
 * a derived part's source document, so only `<id>` counts there:
 * `derived#1:from/extrude#1:cap:end` gives `derived#1` alone. Linear in the name's length, with
 * no recursion, so no input can exhaust the stack.
 */
export function featureIdsInName(name: string): string[] {
  const out = new Set<string>();
  for (const part of parseName(name)) if (part.kind === 'feature') out.add(part.id);
  return [...out];
}

/** Every sub-id tail of a name, by base id (`e7` for `extrude#1:side:e7#a`), in order. */
export function subIdsInName(name: string): string[] {
  const out: string[] = [];
  for (const p of parseName(name)) if (p.kind === 'sub') out.push(p.id);
  return out;
}

/**
 * Compares two names as the kernel orders them: by UTF-16 code unit. A rename that adds a digit
 * can change this order (`e9` sorts after `e10`), which picks a chamfer's reference face and
 * an edge's direction (ADR 0009 amendment, item 9).
 */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
