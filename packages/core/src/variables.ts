// Where variables are used, and the edits that touch every use at once: renaming a variable and
// inlining one (replacing each reference with a literal, then deleting it). Both return one
// `batch` command, so each is a single undo step, checked once at the end like any batch.
// Configurations count as uses: a parameter that configures a variable, and a row value that
// mentions one. So do mates: a connector offset or a limit that reads a variable; print setups:
// a threshold or an item's orientation angle; exploded views: a step's distance; and drawings: a
// custom sheet size, a view's scale or a section's offset.

import { isValidVariableName } from '@manufakture/units';
import { variableParameters, type Command, type SimpleCommand } from './commands';
import {
  explodedViewExpressions,
  featureExpressions,
  mateExpressions,
  printItemExpressions,
  printSetupExpressions,
  printThresholdExpressions,
  sheetExpressions,
  viewExpressions,
  type ExpressionKind,
} from './features';
import { fail, ok, type CoreResult } from './result';
import type {
  ConfigRow,
  DrawingView,
  ExplodedView,
  Feature,
  ManufaktureDocument,
  Mate,
  PrintItem,
  PrintThresholds,
  SheetSize,
  StoredExpression,
} from './schema';
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
    }
  /** A mate's connector offset or limit (`a.offset.translation.0`, `limits.max`). */
  | {
      kind: 'mate';
      assemblyId: string;
      mateId: string;
      path: readonly (string | number)[];
      expected: ExpressionKind;
    }
  /**
   * A print setup's threshold (`thresholds.overhang`, with no `itemId`) or one of its items'
   * orientation angles (`orientation.turn`, with the item's id). `path` is from the setup:
   * `['items', 2, 'orientation', 'turn']` for an item's.
   */
  | {
      kind: 'print';
      setupId: string;
      itemId?: string;
      path: readonly (string | number)[];
      expected: ExpressionKind;
    }
  /** A configuration parameter that configures the variable (it names it, not an expression). */
  | { kind: 'parameter'; parameterId: string }
  /** A configuration row whose value for `parameterId` mentions the variable. */
  | { kind: 'row'; rowId: string; parameterId: string };

/**
 * A use of a variable in an exploded view or a drawing (since version 12). Kept apart from
 * `VariableUse` so code that switches over every `VariableUse` kind keeps working; list them with
 * `drawingVariableUses`. `renameVariable`, `inlineVariable` and `variableUsers` cover them.
 */
export type DrawingVariableUse =
  /**
   * A step distance of an exploded view. `path` is from the exploded view:
   * `['steps', 1, 'distance']`.
   */
  | {
      kind: 'explodedView';
      assemblyId: string;
      explodedViewId: string;
      stepId: string;
      path: readonly (string | number)[];
      expected: ExpressionKind;
    }
  /**
   * A drawing's custom sheet size (no `viewId`) or a view's scale or section offset. `path` is
   * from the drawing: `['sheets', 0, 'views', 2, 'scale', 'model']`.
   */
  | {
      kind: 'drawing';
      drawingId: string;
      sheetId: string;
      viewId?: string;
      path: readonly (string | number)[];
      expected: ExpressionKind;
    };

function mentions(expression: StoredExpression, name: string): boolean {
  const r = expressionReferences(expression.source);
  return r.ok && r.value.some((ref) => ref.name === name);
}

/**
 * Every direct use of variable `name`, in document order: variables, then features, then mates
 * (assembly by assembly, in creation order), then print setups (thresholds, then items), then
 * configuration parameters that configure it, then configuration row values that mention it.
 * Uses in exploded views and drawings are listed by `drawingVariableUses`.
 */
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
  for (const assembly of doc.assemblies) {
    for (const mate of assembly.mates) {
      for (const site of mateExpressions(mate)) {
        if (!mentions(site.expression, name)) continue;
        out.push({
          kind: 'mate',
          assemblyId: assembly.id,
          mateId: mate.id,
          path: site.path,
          expected: site.expected,
        });
      }
    }
  }
  for (const setup of doc.print.setups) {
    for (const site of printSetupExpressions(setup)) {
      if (!mentions(site.expression, name)) continue;
      const use: VariableUse = {
        kind: 'print',
        setupId: setup.id,
        path: site.path,
        expected: site.expected,
      };
      if (site.path[0] === 'items') use.itemId = setup.items[site.path[1] as number]!.id;
      out.push(use);
    }
  }
  for (const p of variableParameters(doc, name)) out.push({ kind: 'parameter', parameterId: p.id });
  for (const row of doc.configurations?.rows ?? []) {
    for (const [parameterId, value] of Object.entries(row.values)) {
      if (typeof value === 'object' && mentions(value, name)) {
        out.push({ kind: 'row', rowId: row.id, parameterId });
      }
    }
  }
  return out;
}

/**
 * Every use of variable `name` in exploded views (assembly by assembly, step by step) and then in
 * drawings (sheet by sheet: its size, then its views), in document order.
 */
export function drawingVariableUses(doc: ManufaktureDocument, name: string): DrawingVariableUse[] {
  const out: DrawingVariableUse[] = [];
  for (const assembly of doc.assemblies) {
    for (const view of assembly.explodedViews ?? []) {
      for (const site of explodedViewExpressions(view)) {
        if (!mentions(site.expression, name)) continue;
        out.push({
          kind: 'explodedView',
          assemblyId: assembly.id,
          explodedViewId: view.id,
          stepId: view.steps[site.path[1] as number]!.id,
          path: site.path,
          expected: site.expected,
        });
      }
    }
  }
  for (const drawing of doc.drawings ?? []) {
    drawing.sheets.forEach((sheet, si) => {
      const base = { kind: 'drawing' as const, drawingId: drawing.id, sheetId: sheet.id };
      for (const site of sheetExpressions(sheet)) {
        if (!mentions(site.expression, name)) continue;
        out.push({ ...base, path: ['sheets', si, ...site.path], expected: site.expected });
      }
      sheet.views.forEach((view, vi) => {
        for (const site of viewExpressions(view)) {
          if (!mentions(site.expression, name)) continue;
          out.push({
            ...base,
            viewId: view.id,
            path: ['sheets', si, 'views', vi, ...site.path],
            expected: site.expected,
          });
        }
      });
    });
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
 * than `name` itself, then features, then mates, then print setups and items, then exploded
 * views, then drawing sheets and views, then configuration rows), without deleting or adding
 * anything.
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
  for (const assembly of doc.assemblies) {
    for (const mate of assembly.mates) {
      let next: Mate = mate;
      for (const site of mateExpressions(mate)) {
        if (!mentions(site.expression, name)) continue;
        const source = rewrite(site.expression.source);
        if (source === null) continue;
        next = replaceAt(next, site.path, { ...site.expression, source });
      }
      if (next !== mate) commands.push({ type: 'editMate', assemblyId: assembly.id, mate: next });
    }
  }
  for (const setup of doc.print.setups) {
    let thresholds: PrintThresholds | undefined = setup.thresholds;
    for (const site of printThresholdExpressions(setup)) {
      if (!mentions(site.expression, name)) continue;
      const source = rewrite(site.expression.source);
      if (source === null) continue;
      thresholds = replaceAt(thresholds, site.path.slice(1), { ...site.expression, source });
    }
    if (thresholds !== setup.thresholds) {
      commands.push({ type: 'editPrintSetup', setupId: setup.id, thresholds: thresholds! });
    }
    for (const item of setup.items) {
      let next: PrintItem = item;
      for (const site of printItemExpressions(item)) {
        if (!mentions(site.expression, name)) continue;
        const source = rewrite(site.expression.source);
        if (source === null) continue;
        next = replaceAt(next, site.path, { ...site.expression, source });
      }
      if (next !== item) commands.push({ type: 'editPrintItem', setupId: setup.id, item: next });
    }
  }
  for (const assembly of doc.assemblies) {
    for (const view of assembly.explodedViews ?? []) {
      let next: ExplodedView = view;
      for (const site of explodedViewExpressions(view)) {
        if (!mentions(site.expression, name)) continue;
        const source = rewrite(site.expression.source);
        if (source === null) continue;
        next = replaceAt(next, site.path, { ...site.expression, source });
      }
      if (next !== view) {
        commands.push({ type: 'editExplodedView', assemblyId: assembly.id, explodedView: next });
      }
    }
  }
  for (const drawing of doc.drawings ?? []) {
    for (const sheet of drawing.sheets) {
      const ids = { drawingId: drawing.id, sheetId: sheet.id };
      let size: SheetSize = sheet.size;
      for (const site of sheetExpressions(sheet)) {
        if (!mentions(site.expression, name)) continue;
        const source = rewrite(site.expression.source);
        if (source === null) continue;
        size = replaceAt(size, site.path.slice(1), { ...site.expression, source });
      }
      if (size !== sheet.size) commands.push({ type: 'editSheet', ...ids, size });
      for (const view of sheet.views) {
        let next: DrawingView = view;
        for (const site of viewExpressions(view)) {
          if (!mentions(site.expression, name)) continue;
          const source = rewrite(site.expression.source);
          if (source === null) continue;
          next = replaceAt(next, site.path, { ...site.expression, source });
        }
        if (next !== view) commands.push({ type: 'editView', ...ids, view: next });
      }
    }
  }
  for (const row of doc.configurations?.rows ?? []) {
    let values: ConfigRow['values'] | undefined;
    for (const [id, value] of Object.entries(row.values)) {
      if (typeof value !== 'object' || !mentions(value, name)) continue;
      const source = rewrite(value.source);
      if (source === null) continue;
      values = { ...(values ?? row.values), [id]: { ...value, source } };
    }
    if (values) commands.push({ type: 'setConfigRow', row: { ...row, values } });
  }
  return commands;
}

/**
 * Rename variable `from` to `to`, updating every reference (as `#to`), including configuration
 * row values, and every configuration parameter that configures it, as one batch. The variable
 * keeps its place in the table. `expression`, when given, is its new expression.
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
    ...variableParameters(doc, from).map((parameter): SimpleCommand => ({
      type: 'setConfigParameter',
      parameter: { ...parameter, variable: to },
    })),
    { type: 'deleteVariable', name: from },
  ];
  return ok({ type: 'batch', commands });
}

/**
 * Replace every reference to `name` with `literal` (the variable's current value, written as an
 * expression by the caller, who evaluates it), then delete the variable: one batch. The literal
 * is parenthesised wherever it is part of a larger expression, so precedence cannot change.
 * References in configuration row values are rewritten too. A configuration parameter that
 * configures the variable is deleted with it, together with every row's value for it: once
 * inlined, the value is the same in every row.
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
    ...variableParameters(doc, name).map((p): SimpleCommand => ({
      type: 'deleteConfigParameter',
      parameterId: p.id,
    })),
    { type: 'deleteVariable', name },
  ];
  return ok({ type: 'batch', commands });
}
