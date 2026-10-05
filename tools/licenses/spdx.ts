// SPDX license expressions (ADR 0006 decision 5): parsed from a package.json `license` field and
// judged against the allowlist in policy.ts. Pure, so it is unit tested (spdx.test.ts).
//
// Grammar (SPDX 2.3 annex D, the parts npm packages use): `id`, `id+`, `id WITH exception`,
// `a AND b`, `a OR b` and parentheses; AND binds tighter than OR. Operators are matched in any
// case. Deprecated ids (`GPL-3.0`, `LGPL-2.1+`) are rewritten to their `-only` and `-or-later`
// forms, so the allowlist names each license once.

export type SpdxNode =
  | { type: 'license'; id: string; exception: string | null }
  | { type: 'and' | 'or'; left: SpdxNode; right: SpdxNode };

/** Thrown for a string that is not an SPDX expression. */
export class SpdxSyntaxError extends Error {}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s*(\(|\)|[^\s()]+)/y;
  let end = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[1]!);
    end = re.lastIndex;
  }
  // A failed sticky match resets lastIndex, so the end of the last token is kept separately.
  if (/\S/.test(text.slice(end))) throw new SpdxSyntaxError(`cannot read "${text}"`);
  return tokens;
}

const GNU = /^(A?GPL|LGPL)-(\d\.\d)(\+)?$/;

/** The id in its current SPDX form: `GPL-3.0` gives `GPL-3.0-only`, `LGPL-2.1+` `LGPL-2.1-or-later`. */
export function normalizeId(raw: string): string {
  const gnu = GNU.exec(raw);
  if (gnu) return `${gnu[1]}-${gnu[2]}-${gnu[3] ? 'or-later' : 'only'}`;
  return raw;
}

const KEYWORDS = new Set(['AND', 'OR', 'WITH']);

/** Parses an SPDX expression; throws SpdxSyntaxError when it is not one. */
export function parseSpdx(text: string): SpdxNode {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => peek()?.toUpperCase() === op;
  const fail = (what: string): never => {
    throw new SpdxSyntaxError(`"${text}": ${what}`);
  };

  function primary(): SpdxNode {
    const token = peek();
    if (token === undefined) return fail('ends too early');
    if (token === '(') {
      pos++;
      const inner = orExpr();
      if (peek() !== ')') fail('a "(" is not closed');
      pos++;
      return inner;
    }
    if (token === ')' || KEYWORDS.has(token.toUpperCase())) return fail(`unexpected "${token}"`);
    pos++;
    if (!/^[A-Za-z0-9.+-]+$/.test(token)) fail(`"${token}" is not a license id`);
    let exception: string | null = null;
    if (isOp('WITH')) {
      pos++;
      const ex = peek();
      if (ex === undefined || ex === '(' || ex === ')' || KEYWORDS.has(ex.toUpperCase())) {
        fail('WITH needs an exception id');
      }
      exception = ex!;
      pos++;
    }
    return { type: 'license', id: normalizeId(token), exception };
  }

  function andExpr(): SpdxNode {
    let left = primary();
    while (isOp('AND')) {
      pos++;
      left = { type: 'and', left, right: primary() };
    }
    return left;
  }

  function orExpr(): SpdxNode {
    let left = andExpr();
    while (isOp('OR')) {
      pos++;
      left = { type: 'or', left, right: andExpr() };
    }
    return left;
  }

  if (tokens.length === 0) fail('is empty');
  const node = orExpr();
  if (pos !== tokens.length) fail(`unexpected "${peek()}"`);
  return node;
}

/** Decides one license (with its exception, if any): null when allowed, else the reason. */
export type LeafRule = (id: string, exception: string | null) => string | null;

export interface Verdict {
  ok: boolean;
  /** Why the expression is not allowed (empty when it is). */
  reasons: string[];
}

/** Whether an expression is allowed: OR needs one allowed side, AND needs both. */
export function evaluate(node: SpdxNode, rule: LeafRule): Verdict {
  switch (node.type) {
    case 'license': {
      const reason = rule(node.id, node.exception);
      return reason === null ? { ok: true, reasons: [] } : { ok: false, reasons: [reason] };
    }
    case 'and': {
      const l = evaluate(node.left, rule);
      const r = evaluate(node.right, rule);
      return { ok: l.ok && r.ok, reasons: [...l.reasons, ...r.reasons] };
    }
    case 'or': {
      const l = evaluate(node.left, rule);
      const r = evaluate(node.right, rule);
      return l.ok || r.ok
        ? { ok: true, reasons: [] }
        : { ok: false, reasons: [...l.reasons, ...r.reasons] };
    }
  }
}

/** Every license id an expression names, for messages. */
export function idsOf(node: SpdxNode): string[] {
  if (node.type === 'license')
    return [node.exception ? `${node.id} WITH ${node.exception}` : node.id];
  return [...idsOf(node.left), ...idsOf(node.right)];
}
