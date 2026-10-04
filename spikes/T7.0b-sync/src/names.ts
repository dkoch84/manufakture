// A rewriter for face names and body ids (the grammar of packages/kernel/src/naming.ts), by
// recursive descent, never by string replacement. Spike quality: it rewrites, it does not
// build a tree; T7.1a's parser and printer replace it.
//
//   born        <feature id>:<role>[:<tail>]      tail: a sub-id (e7, e7#a, e7#1, r2), a nested
//                                                 name, a corner list A&B&C, or opaque (end, 4)
//   instance    pattern#7:i2[/X], mirror#8:image[/X]
//   derived     derived#1:from/X                  X is opaque (a name in another document)
//   merge       (A+B)[#k]
//   body id     extrude#3                          a bare feature id
//
// `feature` maps a feature id, `sub` a sub-id base (`e7`, `r2`) of the same part.

const FEATURE_HEAD = /^([a-z][a-zA-Z0-9]*#[1-9][0-9]*)(?::(.*))?$/s;
const SUB_TAIL = /^([ekr][1-9][0-9]*)((?:#[a-z]+)*(?:#[0-9]+)*)$/;
const INSTANCE = /^(i[0-9]+|image)(?:\/(.*))?$/s;

export interface NameMaps {
  feature(id: string): string;
  sub(id: string): string;
}

/** Splits `s` on `sep` outside parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

export function rewriteName(name: string, maps: NameMaps): string {
  const corners = splitTop(name, '&');
  if (corners.length > 1) return corners.map((c) => rewriteName(c, maps)).join('&');
  if (name.startsWith('(')) {
    // (A+B) with an optional positional suffix after the closing parenthesis.
    let depth = 0;
    let close = -1;
    for (let i = 0; i < name.length; i++) {
      if (name[i] === '(') depth++;
      else if (name[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) return name;
    const members = splitTop(name.slice(1, close), '+').map((m) => rewriteName(m, maps));
    return `(${members.join('+')})${name.slice(close + 1)}`;
  }
  const m = FEATURE_HEAD.exec(name);
  if (!m) return name; // ?face placeholders, opaque text
  const fid = maps.feature(m[1]!);
  const rest = m[2];
  if (rest === undefined) return fid;
  if (rest.startsWith('from/')) return `${fid}:${rest}`; // derived: the source name is opaque
  const inst = INSTANCE.exec(rest);
  if (inst) {
    return inst[2] === undefined
      ? `${fid}:${inst[1]}`
      : `${fid}:${inst[1]}/${rewriteName(inst[2], maps)}`;
  }
  const colon = rest.indexOf(':');
  if (colon < 0) return `${fid}:${rest}`; // role only (cap:end is role + tail; `layer/x` keys)
  const role = rest.slice(0, colon);
  const tail = rest.slice(colon + 1);
  const sub = SUB_TAIL.exec(tail);
  if (sub) return `${fid}:${role}:${maps.sub(sub[1]!)}${sub[2]}`;
  if (FEATURE_HEAD.test(tail) || tail.startsWith('(') || tail.includes('&')) {
    return `${fid}:${role}:${rewriteName(tail, maps)}`;
  }
  return `${fid}:${role}:${tail}`;
}

/** Every feature id a name mentions outside derived sources (for the intent check). */
export function featureIdsOf(name: string): string[] {
  const out: string[] = [];
  rewriteName(name, {
    feature: (id) => {
      out.push(id);
      return id;
    },
    sub: (id) => id,
  });
  return out;
}

/** Every (feature id, sub-id) pair of born names `X:role:<sub>` in a name. */
export function bornSubIds(name: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let current = '';
  rewriteName(name, {
    feature: (id) => {
      current = id;
      return id;
    },
    sub: (id) => {
      out.push([current, id]);
      return id;
    },
  });
  return out;
}
