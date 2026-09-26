// Where variables are used, and the edits that touch every use at once: renaming a variable and
// inlining one (replacing each reference with a literal, then deleting it). Both return one
// `batch` command, so each is a single undo step, checked once at the end like any batch.

import { isValidVariableName } from '@manufakture/units';
import type { Command, SimpleCommand } from './commands';
import { featureExpressions, type ExpressionKind } from './features';
import { fail, ok, type CoreResult } from './result';
import type { Feature, ManufaktureDocument, StoredExpression } from './schema';
import { expressionReferences } from './validate';

/** One place that reads a variable directly: another variable, or a feature's field. */
export type VariableUse =
  | { kind: 'variable'; name: string }
  | {
      kind: 'feature';
      partId: string;
      featureId: string;
      /** Where the expression is in the feature (`extent.distance`, `constraints.3.value`). */
      path: readonly (string | number)[];
      expected: ExpressionKind;
      /** For a sketch dimension: the constraint's id. */
      constraintId?: string;
    };

function mentions(expression: StoredExpression, name: string): boolean {
  const r = expressionReferences(expression.source);
  return r.ok && r.value.some((ref) => ref.name === name);
}

/** Every direct use of variable `name`, in document order (variables first, then features). */
export function variableUses(doc: ManufaktureDocument, name: string): VariableUse[] {
  const out: VariableUse[] = [];
  for (const v of doc.variables) {
    if (v.name !== name && mentions(v.expression, name))
      out.push({ kind: 'variable', name: v.name });
  }
  for (const part of doc.parts) {
    for (const f of part.features) {
      for (const site of featureExpressions(f)) {
        if (!mentions(site.expression, name)) continue;
        const use: VariableUse = {
          kind: 'feature',
          partId: part.id,
          featureId: f.id,
          path: site.path,
          expected: site.expected,
        };
        if (f.kind === 'sketch' && site.path[0] === 'constraints') {
          const c = f.constraints[site.path[1] as number];
          if (c) use.constraintId = c.id;
        }
        out.push(use);
      }
    }
  }
  return out;
}

/**
 * `source` with every reference to variable `name` replaced by `replacement(hashed)`, or null
 * when it does not parse. References are found by the parser, so text inside other names
 * (`#width` when renaming `w`) is never touched.
 */
export function rewriteReferences(
  source: string,
  name: string,
  replacement: (ref: { hashed: boolean; whole: boolean }) => string,
): string | null {
  const r = expressionReferences(source);
  if (!r.ok) return null;
  const refs = r.value.filter((ref) => ref.name === name);
  let out = source;
  // Right to left, so earlier offsets stay valid.
  for (const ref of [...refs].reverse()) {
    const whole = source.slice(0, ref.start).trim() === '' && source.slice(ref.end).trim() === '';
    out = out.slice(0, ref.start) + replacement({ hashed: ref.hashed, whole }) + out.slice(ref.end);
  }
  return out;
}

/** A copy of `value` with the object at `path` replaced by `next`. */
function replaceAt<T>(value: T, path: readonly (string | number)[], next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[head as number] = replaceAt(copy[head as number], rest, next);
    return copy as T;
  }
  const obj = value as Record<string, unknown>;
  return { ...obj, [head as string]: replaceAt(obj[head as string], rest, next) } as T;
}

/**
 * The commands that rewrite every expression reading `name` with `rewrite` (variables other
 * than `name` itself, then features), without deleting or adding anything.
 */
function rewriteUses(
  doc: ManufaktureDocument,
  name: string,
  rewrite: (source: string) => string | null,
): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  for (const v of doc.variables) {
    if (v.name === name || !mentions(v.expression, name)) continue;
    const source = rewrite(v.expression.source);
    if (source === null) continue;
    commands.push({ type: 'setVariable', name: v.name, expression: { ...v.expression, source } });
  }
  for (const part of doc.parts) {
    for (const f of part.features) {
      let next: Feature = f;
      for (const site of featureExpressions(f)) {
        if (!mentions(site.expression, name)) continue;
        const source = rewrite(site.expression.source);
        if (source === null) continue;
        next = replaceAt(next, site.path, { ...site.expression, source });
      }
      if (next !== f) commands.push({ type: 'editFeature', partId: part.id, feature: next });
    }
  }
  return commands;
}

/**
 * Rename variable `from` to `to`, updating every reference (as `#to`), as one batch. The
 * variable keeps its place in the table. `expression`, when given, is its new expression.
 */
export function renameVariable(
  doc: ManufaktureDocument,
  from: string,
  to: string,
  expression?: StoredExpression,
): CoreResult<Command> {
  const i = doc.variables.findIndex((v) => v.name === from);
  const old = doc.variables[i];
  if (!old) return fail('not-found', `No variable "${from}"`, ['name']);
  if (!isValidVariableName(to)) {
    return fail('invalid-name', `"${to}" is not a valid variable name`, ['name']);
  }
  if (to !== from && doc.variables.some((v) => v.name === to)) {
    return fail('duplicate', `There is already a variable "${to}"`, ['name'], { blockers: [to] });
  }
  const own = expression ?? old.expression;
  if (to === from) return ok({ type: 'setVariable', name: from, expression: own });
  const commands: SimpleCommand[] = [
    // In at the old position; the old one moves down one and goes last.
    { type: 'setVariable', name: to, expression: own, index: i },
    ...rewriteUses(doc, from, (s) => rewriteReferences(s, from, () => `#${to}`)),
    { type: 'deleteVariable', name: from },
  ];
  return ok({ type: 'batch', commands });
}

/**
 * Replace every reference to `name` with `literal` (the variable's current value, written as an
 * expression by the caller, who evaluates it), then delete the variable: one batch. The literal
 * is parenthesised wherever it is part of a larger expression, so precedence cannot change.
 */
export function inlineVariable(
  doc: ManufaktureDocument,
  name: string,
  literal: string,
): CoreResult<Command> {
  if (!doc.variables.some((v) => v.name === name)) {
    return fail('not-found', `No variable "${name}"`, ['name']);
  }
  const lit = literal.trim();
  if (!expressionReferences(lit).ok) {
    return fail('expression', `"${literal}" is not a valid expression`, ['literal']);
  }
  const commands: SimpleCommand[] = [
    ...rewriteUses(doc, name, (s) =>
      rewriteReferences(s, name, ({ whole }) => (whole ? lit : `(${lit})`)),
    ),
    { type: 'deleteVariable', name },
  ];
  return ok({ type: 'batch', commands });
}
