import {
  findReferences,
  isValidVariableName,
  type Result as UnitsResult,
  type VariableReference,
} from '@manufakture/units';
import {
  bodyCreator,
  constraintTargets,
  explicitDependencies,
  explodeStepInstances,
  featureDependencies,
  featureExpressions,
  featureScope,
  featureSubIds,
  instancePart,
  mateConnectors,
  mateExpressions,
  mateIds,
  printItemExpressions,
  printItemIds,
  printThresholdExpressions,
  sheetExpressions,
  viewExpressions,
} from './features';
import { PART_COUNTER, parseAnyId, parseFeatureId, parseSubId, peekCounter } from './ids';
import { fail, ok, type CoreError, type CoreResult } from './result';
import {
  ASSEMBLY_COUNTER,
  CONFIG_PARAMETER_COUNTER,
  CONFIG_ROW_COUNTER,
  DRAWING_COUNTER,
  FONT_COUNTER,
  MAX_SKETCH_OUTLINE_TEXT,
  SKETCH_ORIGIN,
  codePointLength,
  type Assembly,
  type ConfigRow,
  type Configurations,
  type Drawing,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type PrintData,
  type SketchFeature,
  type StoredExpression,
  type Variable,
} from './schema';

/**
 * Rules that span several objects, checked after the schema. A document in a store, and every
 * document a command produces, passes all of them; a loaded document that fails one is reported,
 * never repaired (ADR 0004 decision 9).
 *
 * Deliberately not checked here: whether a profile's entities, a hole's points or a revolve's
 * axis line still exist in the sketch they name, and whether a geometry reference resolves.
 * Those are regen results (a `FeatureError` on the dependent feature), so that editing a sketch
 * is never blocked by the features built on it.
 */

const parseCache = new Map<string, UnitsResult<VariableReference[]>>();

/** The variables an expression mentions (parse only; cached by source text). */
export function expressionReferences(source: string): UnitsResult<VariableReference[]> {
  let r = parseCache.get(source);
  if (!r) {
    if (parseCache.size > 10_000) parseCache.clear();
    r = findReferences(source);
    parseCache.set(source, r);
  }
  return r;
}

/** Names of the variables an expression mentions, without duplicates; empty when it does not parse. */
export function expressionVariableNames(expression: StoredExpression): string[] {
  const r = expressionReferences(expression.source);
  return r.ok ? [...new Set(r.value.map((v) => v.name))] : [];
}

function checkExpression(
  expression: StoredExpression,
  path: readonly (string | number)[],
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const r = expressionReferences(expression.source);
  if (!r.ok) {
    out.push({
      code: 'expression',
      message: `Invalid expression "${expression.source}": ${r.error.message}`,
      path: [...path, 'source'],
      unitsError: r.error,
    });
    return;
  }
  for (const ref of r.value) {
    if (!variables.has(ref.name)) {
      out.push({
        code: 'unknown-variable',
        message: `Unknown variable "${ref.name}" in "${expression.source}"`,
        path: [...path, 'source'],
        blockers: [ref.name],
      });
    }
  }
}

/**
 * Variables in dependency order (each after every variable it references), or a
 * `variable-cycle` error naming the variables on the cycle. Assumes every expression parses.
 */
export function variableOrder(variables: readonly Variable[]): CoreResult<string[]> {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: string[] = [];
  const stack: string[] = [];
  const visit = (name: string): string[] | undefined => {
    const s = state.get(name);
    if (s === 'done') return undefined;
    if (s === 'visiting') return stack.slice(stack.indexOf(name));
    const v = byName.get(name);
    if (!v) return undefined;
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of expressionVariableNames(v.expression)) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    order.push(name);
    return undefined;
  };
  for (const v of variables) {
    const cycle = visit(v.name);
    if (cycle) {
      return fail(
        'variable-cycle',
        `Variables reference each other: ${[...cycle, cycle[0]].join(' -> ')}`,
        [],
        {
          blockers: cycle,
        },
      );
    }
  }
  return ok(order);
}

function checkVariables(variables: readonly Variable[], out: CoreError[]): Set<string> {
  const names = new Set<string>();
  variables.forEach((v, i) => {
    const path = ['variables', i];
    if (!isValidVariableName(v.name)) {
      out.push({
        code: 'invalid-name',
        message: `"${v.name}" is not a valid variable name`,
        path: [...path, 'name'],
      });
    } else if (names.has(v.name)) {
      out.push({
        code: 'duplicate',
        message: `Variable "${v.name}" is defined twice`,
        path: [...path, 'name'],
      });
    }
    names.add(v.name);
  });
  const before = out.length;
  variables.forEach((v, i) =>
    checkExpression(v.expression, ['variables', i, 'expression'], names, out),
  );
  if (out.length === before) {
    const order = variableOrder(variables);
    if (!order.ok) out.push({ ...order.error, path: ['variables'] });
  }
  return names;
}

/** The vertices each entity kind has, for point references with `at`. */
const VERTICES: Record<string, readonly string[]> = {
  point: [],
  line: ['start', 'end'],
  circle: ['center'],
  arc: ['start', 'end', 'center'],
  outline: ['anchor'],
};

/**
 * Referential checks inside one sketch: every constraint names entities of this sketch (or a
 * built-in), and every point reference names a vertex its entity has. Whether a constraint makes
 * geometric sense (parallel circles) is the sketch package's call, reported when it solves.
 */
function checkSketch(
  sketch: SketchFeature,
  path: readonly (string | number)[],
  fontIds: ReadonlySet<string>,
  out: CoreError[],
): void {
  const entities = new Map(sketch.entities.map((e) => [e.id, e]));
  let text = 0;
  sketch.entities.forEach((e, ei) => {
    if (e.kind !== 'outline') return;
    const epath = [...path, 'entities', ei];
    if (e.id.includes('#')) {
      // Glyph edge ids are built on the entity id, which therefore takes no split suffix.
      out.push({
        code: 'invalid-id',
        message: `Outline ${e.id} cannot be a split piece`,
        path: [...epath, 'id'],
      });
    }
    if (!fontIds.has(e.source.font)) {
      out.push({
        code: 'dependency',
        message: `Outline ${e.id} uses font ${e.source.font}, which the document does not have`,
        path: [...epath, 'source', 'font'],
        blockers: [e.source.font],
      });
    }
    text += codePointLength(e.source.text);
  });
  if (text > MAX_SKETCH_OUTLINE_TEXT) {
    out.push({
      code: 'sketch',
      message: `The texts of ${sketch.id} hold ${text} characters together; a sketch holds at most ${MAX_SKETCH_OUTLINE_TEXT}`,
      path: [...path, 'entities'],
    });
  }
  sketch.constraints.forEach((c, ci) => {
    const cpath = [...path, 'constraints', ci];
    for (const t of constraintTargets(c)) {
      const tpath = [...cpath, t.field];
      if (t.entity.startsWith('@')) {
        if (t.isPoint && (t.entity !== SKETCH_ORIGIN || t.at !== undefined)) {
          out.push({
            code: 'sketch',
            message: `Constraint ${c.id}: ${t.entity}${t.at ? ` ${t.at}` : ''} is not a point`,
            path: tpath,
          });
        }
        continue;
      }
      const e = entities.get(t.entity);
      if (!e) {
        out.push({
          code: 'sketch',
          message: `Constraint ${c.id} names ${t.entity}, which is not in this sketch`,
          path: tpath,
          blockers: [t.entity],
        });
        continue;
      }
      if (!t.isPoint) continue;
      const vertices = VERTICES[e.kind]!;
      if (t.at === undefined ? vertices.length > 0 : !vertices.includes(t.at)) {
        out.push({
          code: 'sketch',
          message:
            t.at === undefined
              ? `Constraint ${c.id}: say which point of ${t.entity} (a ${e.kind}) is meant`
              : `Constraint ${c.id}: a ${e.kind} has no ${t.at} point`,
          path: tpath,
        });
      }
    }
  });
}

/** Whether a feature makes a body of its own: an extrude, revolve or import that is `new` or `add`. */
function makesBody(feature: Feature | undefined): boolean {
  return (
    (feature?.kind === 'extrude' || feature?.kind === 'revolve' || feature?.kind === 'import') &&
    (feature.operation === 'new' || feature.operation === 'add')
  );
}

/**
 * A derived feature's `bodies` as a set, made once per list: validation looks up every body id
 * naming the feature in it, so a linear scan per id would make a crafted file quadratic.
 * Documents are immutable, so the list itself is the key.
 */
const derivedBodySets = new WeakMap<readonly string[], ReadonlySet<string>>();
function derivedBodies(bodies: readonly string[]): ReadonlySet<string> {
  let set = derivedBodySets.get(bodies);
  if (set === undefined) {
    set = new Set(bodies);
    derivedBodySets.set(bodies, set);
  }
  return set;
}

/**
 * Why a feature cannot create the body `bodyId` names, or `undefined` when it can. Extrude,
 * revolve and import make one body under their own id with a `new` operation, and with `add`
 * when the solid touches no body (M2 plan, decision 2: known only after regen, which reports
 * props on an `add` that merged as lost). A pattern or mirror makes its copies under an instance
 * suffix (`pattern#2:i3`, `mirror#1:image`): of bodies, and of features when one of the features
 * it repeats makes a body (`new`, or `add` copies touching nothing); which suffixes exist is a
 * regen result. A derived feature with `new` or `add` makes its bodies under
 * `<id>:from/<source body id>`, one per source body it derives (all, or those in `bodies`); which
 * source bodies exist is a regen result too. An extension with `new` or `add` makes its bodies
 * under its own id, alone or with a key (`extension#3`, `extension#3:layer/a`; ADR 0013 decision
 * 6); which keys exist is up to its domain, so any is accepted. `features` looks up the repeated
 * features by id; without it, a pattern of features makes no body.
 */
export function bodyCreationProblem(
  creator: Feature,
  bodyId: string,
  features?: (id: string) => Feature | undefined,
): string | undefined {
  const suffix = bodyId.length > creator.id.length;
  switch (creator.kind) {
    case 'extrude':
    case 'revolve':
    case 'import':
      if (!makesBody(creator)) {
        return `${creator.id} is a "${creator.operation}" ${creator.kind}, which makes no body`;
      }
      return suffix ? `${creator.id} makes one body, named "${creator.id}"` : undefined;
    case 'derived': {
      if (creator.operation !== 'new' && creator.operation !== 'add') {
        return `${creator.id} is a "${creator.operation}" derived feature, which makes no body`;
      }
      const prefix = `${creator.id}:from/`;
      if (!bodyId.startsWith(prefix) || bodyId.length === prefix.length) {
        return `a body made by ${creator.id} is named after its source body, like "${prefix}extrude#1"`;
      }
      const source = bodyId.slice(prefix.length);
      if (creator.bodies !== undefined && !derivedBodies(creator.bodies).has(source)) {
        return `${creator.id} does not derive the source body "${source}"`;
      }
      return undefined;
    }
    case 'extension':
      if (creator.operation !== 'new' && creator.operation !== 'add') {
        return creator.operation === undefined
          ? `${creator.id} is an extension with no operation, which makes no body`
          : `${creator.id} is a "${creator.operation}" extension, which makes no body`;
      }
      return bodyId.length === creator.id.length + 1
        ? `a body made by ${creator.id} is named "${creator.id}" or "${creator.id}:<key>"`
        : undefined;
    case 'pattern':
    case 'mirror':
      if (creator.body !== true && !creator.features.some((id) => makesBody(features?.(id)))) {
        return `${creator.id} repeats features that make no body (only a new or add extrude, revolve or import does), so it makes no body`;
      }
      return suffix
        ? undefined
        : `a body made by ${creator.id} is named after its copy, like "${creator.id}:${creator.kind === 'pattern' ? 'i2' : 'image'}"`;
    default:
      return `${creator.id} is a ${creator.kind}, which makes no body`;
  }
}

/**
 * Checks a body id against the part: its creating feature exists, can make that body, and (for a
 * `scope` of the feature at `before`) comes earlier in the list.
 */
function checkBodyId(
  part: Part,
  index: ReadonlyMap<string, number>,
  bodyId: string,
  before: number | undefined,
  path: readonly (string | number)[],
  out: CoreError[],
): void {
  const creatorId = bodyCreator(bodyId);
  const ci = creatorId === undefined ? undefined : index.get(creatorId);
  if (creatorId === undefined || ci === undefined) {
    out.push({
      code: 'dependency',
      message: `Body "${bodyId}" names ${creatorId ?? 'no feature'}, which does not exist`,
      path,
      blockers: creatorId === undefined ? [] : [creatorId],
    });
    return;
  }
  const problem = bodyCreationProblem(part.features[ci]!, bodyId, (id) => {
    const i = index.get(id);
    return i === undefined ? undefined : part.features[i];
  });
  if (problem !== undefined) {
    out.push({
      code: 'kind-mismatch',
      message: `Body "${bodyId}" cannot exist: ${problem}`,
      path,
      blockers: [creatorId],
    });
    return;
  }
  // A later creator is already a dependency error (featureDependencies); the feature's own id is
  // not, since a feature never depends on itself.
  if (before !== undefined && ci === before) {
    out.push({
      code: 'dependency',
      message: `${creatorId} cannot act on the body it makes`,
      path,
      blockers: [creatorId],
    });
  }
}

function checkDuplicates(
  ids: readonly string[],
  what: string,
  path: readonly (string | number)[],
  out: CoreError[],
): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) {
      out.push({
        code: 'duplicate',
        message: `Body "${id}" is listed twice in ${what}`,
        path: [...path, i],
        blockers: [id],
      });
    }
    seen.add(id);
  });
}

function checkPart(
  part: Part,
  pi: number,
  variables: ReadonlySet<string>,
  fontIds: ReadonlySet<string>,
  out: CoreError[],
): void {
  const ppath = ['parts', pi];
  const index = new Map<string, number>();
  const subIds = new Set<string>();

  part.features.forEach((f, fi) => {
    const fpath = [...ppath, 'features', fi];
    const parsed = parseFeatureId(f.id);
    if (!parsed || parsed.counter !== f.kind) {
      out.push({
        code: 'invalid-id',
        message: `Feature id "${f.id}" does not match its kind "${f.kind}"`,
        path: [...fpath, 'id'],
      });
    } else if (parsed.n >= peekCounter(part.nextIds, parsed.counter)) {
      out.push({
        code: 'invalid-id',
        message: `Feature id "${f.id}" was never allocated (next ${f.kind} id is ${peekCounter(part.nextIds, parsed.counter)})`,
        path: [...fpath, 'id'],
      });
    }
    if (index.has(f.id)) {
      out.push({
        code: 'duplicate',
        message: `Feature id "${f.id}" is used twice`,
        path: [...fpath, 'id'],
      });
    } else {
      index.set(f.id, fi);
    }
    for (const id of featureSubIds(f)) {
      const sub = parseSubId(id);
      if (sub && sub.n >= peekCounter(part.nextIds, sub.counter)) {
        out.push({
          code: 'invalid-id',
          message: `Id "${id}" in ${f.id} was never allocated`,
          path: fpath,
          blockers: [id],
        });
      }
      if (subIds.has(id)) {
        out.push({
          code: 'duplicate',
          message: `Id "${id}" is used twice in part ${part.id}`,
          path: fpath,
          blockers: [id],
        });
      }
      subIds.add(id);
    }
  });

  if (part.rollbackIndex !== null && part.rollbackIndex > part.features.length) {
    out.push({
      code: 'invalid-index',
      message: `Rollback index ${part.rollbackIndex} is past the end of ${part.features.length} features`,
      path: [...ppath, 'rollbackIndex'],
    });
  }

  part.features.forEach((f, fi) => {
    const fpath = [...ppath, 'features', fi];
    for (const dep of featureDependencies(f)) {
      const di = index.get(dep);
      if (di === undefined) {
        out.push({
          code: 'dependency',
          message: `${f.id} references ${dep}, which does not exist`,
          path: fpath,
          blockers: [dep],
        });
      } else if (di > fi) {
        out.push({
          code: 'dependency',
          message: `${f.id} references ${dep}, which comes after it`,
          path: fpath,
          blockers: [dep],
        });
      }
    }
    if (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'hole') {
      const sketchId = explicitDependencies(f)[0]!;
      const target = part.features[index.get(sketchId) ?? -1];
      if (target && target.kind !== 'sketch') {
        out.push({
          code: 'kind-mismatch',
          message: `${f.id} needs a sketch, but ${sketchId} is a ${target.kind}`,
          path: fpath,
          blockers: [sketchId],
        });
      }
    }
    const scope = featureScope(f);
    checkDuplicates(scope, `the scope of ${f.id}`, [...fpath, 'scope'], out);
    scope.forEach((body, si) => checkBodyId(part, index, body, fi, [...fpath, 'scope', si], out));
    if (f.kind === 'sketch') checkSketch(f, fpath, fontIds, out);
    // Source body ids name bodies of the source document: only duplicates are checked here.
    if (f.kind === 'derived' && f.bodies !== undefined) {
      checkDuplicates(f.bodies, `the bodies ${f.id} derives`, [...fpath, 'bodies'], out);
    }
    for (const site of featureExpressions(f))
      checkExpression(site.expression, [...fpath, ...site.path], variables, out);
  });

  const bodies = part.bodies.map((b) => b.id);
  checkDuplicates(bodies, `the bodies of part ${part.id}`, [...ppath, 'bodies'], out);
  bodies.forEach((body, bi) =>
    checkBodyId(part, index, body, undefined, [...ppath, 'bodies', bi, 'id'], out),
  );
}

/**
 * The variables with a configuration row's expression overrides applied, in their order. A
 * parameter the row has no value for leaves its variable as it is.
 */
export function configuredVariables(
  variables: readonly Variable[],
  table: Configurations,
  row: ConfigRow,
): Variable[] {
  const overrides = new Map<string, StoredExpression>();
  for (const p of table.parameters) {
    const value = row.values[p.id];
    if (p.kind === 'variable' && typeof value === 'object') overrides.set(p.variable, value);
  }
  if (overrides.size === 0) return variables.slice();
  return variables.map((v) => {
    const expression = overrides.get(v.name);
    return expression ? { name: v.name, expression } : v;
  });
}

/** `n` of an id `<counter>#n`, or undefined. */
function counted(id: string, counter: string): number | undefined {
  const m = /^([a-z]+)#([1-9][0-9]*)$/.exec(id);
  return m && m[1] === counter ? Number(m[2]) : undefined;
}

function checkAllocated(
  id: string,
  counter: string,
  nextIds: Readonly<Record<string, number>>,
  what: string,
  path: readonly (string | number)[],
  out: CoreError[],
): void {
  const n = counted(id, counter);
  if (n !== undefined && n >= peekCounter(nextIds, counter)) {
    out.push({
      code: 'invalid-id',
      message: `${what} id "${id}" was never allocated (next is ${counter}#${peekCounter(nextIds, counter)})`,
      path,
    });
  }
}

function checkUnique(
  values: readonly string[],
  what: string,
  path: (i: number) => (string | number)[],
  out: CoreError[],
): void {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (seen.has(v)) {
      out.push({ code: 'duplicate', message: `${what} "${v}" is used twice`, path: path(i) });
    }
    seen.add(v);
  });
}

/**
 * The configuration table: ids allocated and unique, names unique, every parameter names a
 * variable or feature that exists (one parameter each), every row value is for a parameter of
 * the table and of its kind, row expressions parse and name existing variables, applying a row
 * makes no variable cycle, and `active` is a row.
 */
function checkConfigurations(
  doc: ManufaktureDocument,
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const table = doc.configurations;
  if (!table) return;
  const base = ['configurations'];
  const ppath = (i: number) => [...base, 'parameters', i];
  const rpath = (i: number) => [...base, 'rows', i];
  const params = new Map(table.parameters.map((p) => [p.id, p]));
  checkUnique(
    table.parameters.map((p) => p.id),
    'Configuration parameter id',
    (i) => [...ppath(i), 'id'],
    out,
  );
  checkUnique(
    table.parameters.map((p) => p.name),
    'Configuration parameter name',
    (i) => [...ppath(i), 'name'],
    out,
  );
  const targets = new Set<string>();
  table.parameters.forEach((p, i) => {
    checkAllocated(
      p.id,
      CONFIG_PARAMETER_COUNTER,
      doc.nextIds,
      'Configuration parameter',
      [...ppath(i), 'id'],
      out,
    );
    let target: string;
    if (p.kind === 'variable') {
      target = `variable ${p.variable}`;
      if (!variables.has(p.variable)) {
        out.push({
          code: 'unknown-variable',
          message: `Configuration parameter ${p.id} names variable "${p.variable}", which does not exist`,
          path: [...ppath(i), 'variable'],
          blockers: [p.variable],
        });
      }
    } else {
      target = `feature ${p.partId}/${p.featureId}`;
      const part = doc.parts.find((x) => x.id === p.partId);
      if (!part || !part.features.some((f) => f.id === p.featureId)) {
        out.push({
          code: 'dependency',
          message: `Configuration parameter ${p.id} names ${part ? p.featureId : `part ${p.partId}`}, which does not exist`,
          path: [...ppath(i), part ? 'featureId' : 'partId'],
          blockers: [part ? p.featureId : p.partId],
        });
      }
    }
    if (targets.has(target)) {
      out.push({
        code: 'duplicate',
        message: `Two configuration parameters configure ${target}`,
        path: ppath(i),
        blockers: [p.id],
      });
    }
    targets.add(target);
  });

  checkUnique(
    table.rows.map((r) => r.id),
    'Configuration row id',
    (i) => [...rpath(i), 'id'],
    out,
  );
  checkUnique(
    table.rows.map((r) => r.name),
    'Configuration row name',
    (i) => [...rpath(i), 'name'],
    out,
  );
  table.rows.forEach((row, ri) => {
    checkAllocated(
      row.id,
      CONFIG_ROW_COUNTER,
      doc.nextIds,
      'Configuration row',
      [...rpath(ri), 'id'],
      out,
    );
    const before = out.length;
    for (const [pid, value] of Object.entries(row.values)) {
      const vpath = [...rpath(ri), 'values', pid];
      const p = params.get(pid);
      if (!p) {
        out.push({
          code: 'not-found',
          message: `Configuration row ${row.id} has a value for ${pid}, which is not a parameter`,
          path: vpath,
          blockers: [pid],
        });
      } else if (p.kind === 'variable' && typeof value !== 'object') {
        out.push({
          code: 'kind-mismatch',
          message: `Configuration row ${row.id}: ${pid} configures a variable, so its value is an expression`,
          path: vpath,
        });
      } else if (p.kind === 'suppression' && typeof value !== 'boolean') {
        out.push({
          code: 'kind-mismatch',
          message: `Configuration row ${row.id}: ${pid} configures a suppression, so its value is true or false`,
          path: vpath,
        });
      } else if (typeof value === 'object') {
        checkExpression(value, vpath, variables, out);
      }
    }
    if (out.length === before) {
      const order = variableOrder(configuredVariables(doc.variables, table, row));
      if (!order.ok) {
        out.push({
          ...order.error,
          message: `In configuration row ${row.id}: ${order.error.message}`,
          path: [...rpath(ri), 'values'],
        });
      }
    }
  });
  if (table.active !== null && !table.rows.some((r) => r.id === table.active)) {
    out.push({
      code: 'not-found',
      message: `The active configuration "${table.active}" is not a row`,
      path: [...base, 'active'],
      blockers: [table.active],
    });
  }
}

/**
 * One assembly: every id in it (instances, mates, connectors, connector references) allocated by
 * the assembly's `nextIds` and used once; every instance of a part of this document names a part
 * that exists; no body listed twice in an instance; every connector on an instance of this
 * assembly, the two connectors of a mate on two different instances; every expression parses and
 * names existing variables. Connector references and instance bodies name geometry of the source
 * part, so, like a feature's references, whether they resolve is a regen result.
 */
function checkAssembly(
  assembly: Assembly,
  ai: number,
  partIds: ReadonlySet<string>,
  rowIds: ReadonlySet<string>,
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const apath = ['assemblies', ai];
  const seen = new Set<string>();
  const checkId = (id: string, path: readonly (string | number)[]) => {
    const parsed = parseAnyId(id);
    if (
      parsed &&
      (parsed.split !== '' || parsed.n >= peekCounter(assembly.nextIds, parsed.counter))
    ) {
      out.push({
        code: 'invalid-id',
        message:
          parsed.split !== ''
            ? `Id "${id}" in assembly ${assembly.id} is a split piece; assemblies have none`
            : `Id "${id}" in assembly ${assembly.id} was never allocated (next is ${previewId(parsed.counter, peekCounter(assembly.nextIds, parsed.counter))})`,
        path,
        blockers: [id],
      });
    }
    if (seen.has(id)) {
      out.push({
        code: 'duplicate',
        message: `Id "${id}" is used twice in assembly ${assembly.id}`,
        path,
        blockers: [id],
      });
    }
    seen.add(id);
  };

  const instances = new Set<string>();
  assembly.instances.forEach((instance, ii) => {
    const ipath = [...apath, 'instances', ii];
    checkId(instance.id, [...ipath, 'id']);
    instances.add(instance.id);
    const part = instancePart(instance.source);
    if (part !== undefined && !partIds.has(part)) {
      out.push({
        code: 'dependency',
        message: `Instance ${instance.id} shows part ${part}, which does not exist`,
        path: [...ipath, 'source', 'part'],
        blockers: [part],
      });
    }
    // A pinned source's row is a row of the source document: regen checks it (T2.4c).
    const row = part === undefined ? undefined : instance.source.configuration;
    if (row !== undefined && !rowIds.has(row)) {
      out.push({
        code: 'not-found',
        message: `Instance ${instance.id} is built in configuration "${row}", which is not a row`,
        path: [...ipath, 'source', 'configuration'],
        blockers: [row],
      });
    }
    if (instance.bodies !== undefined) {
      checkDuplicates(
        instance.bodies,
        `the bodies instance ${instance.id} shows`,
        [...ipath, 'bodies'],
        out,
      );
    }
  });

  assembly.mates.forEach((mate, mi) => {
    const mpath = [...apath, 'mates', mi];
    // In the order `mateIds` lists them.
    const idPaths = [
      ['id'],
      ['a', 'id'],
      ['a', 'origin', 'id'],
      ['b', 'id'],
      ['b', 'origin', 'id'],
    ];
    mateIds(mate).forEach((id, k) => checkId(id, [...mpath, ...idPaths[k]!]));
    const [a, b] = mateConnectors(mate);
    for (const [side, c] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (!instances.has(c.instance)) {
        out.push({
          code: 'dependency',
          message: `Mate ${mate.id} connects ${c.instance}, which is not an instance of assembly ${assembly.id}`,
          path: [...mpath, side, 'instance'],
          blockers: [c.instance],
        });
      }
    }
    if (mate.a.instance === mate.b.instance) {
      out.push({
        code: 'dependency',
        message: `Mate ${mate.id} connects ${mate.a.instance} to itself; a mate joins two instances`,
        path: [...mpath, 'b', 'instance'],
        blockers: [mate.b.instance],
      });
    }
    for (const site of mateExpressions(mate)) {
      checkExpression(site.expression, [...mpath, ...site.path], variables, out);
    }
  });

  (assembly.explodedViews ?? []).forEach((view, ei) => {
    const epath = [...apath, 'explodedViews', ei];
    checkId(view.id, [...epath, 'id']);
    view.steps.forEach((step, si) => {
      const spath = [...epath, 'steps', si];
      checkId(step.id, [...spath, 'id']);
      const moved = new Set<string>();
      step.instances.forEach((id, k) => {
        if (moved.has(id)) {
          out.push({
            code: 'duplicate',
            message: `Step ${step.id} of ${view.id} moves ${id} twice`,
            path: [...spath, 'instances', k],
            blockers: [id],
          });
        }
        moved.add(id);
      });
      const named = explodeStepInstances(step);
      named.forEach((id, k) => {
        if (instances.has(id)) return;
        out.push({
          code: 'dependency',
          message: `Step ${step.id} of exploded view ${view.id} names ${id}, which is not an instance of assembly ${assembly.id}`,
          path:
            k < step.instances.length
              ? [...spath, 'instances', k]
              : [...spath, 'direction', 'instance'],
          blockers: [id],
        });
      });
      checkExpression(step.distance, [...spath, 'distance'], variables, out);
    });
  });
}

/**
 * The print section (ADR 0012 decisions 1 and 2): every id in it (setups, items, face
 * references) allocated by `print.nextIds` and used once; every item names a part of this
 * document; every expression parses and names existing variables. Deliberately not checked: that
 * an item's body or `layFlat` face still exists, or that the printer is in the printer table.
 * Those are print workspace results (`reference-lost`, an unknown printer), so deleting or
 * changing what they name is never blocked; the schema has already checked they are well formed.
 */
function checkPrint(
  print: PrintData,
  partIds: ReadonlySet<string>,
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const seen = new Set<string>();
  const checkId = (id: string, path: readonly (string | number)[]) => {
    const parsed = parseAnyId(id);
    if (parsed && (parsed.split !== '' || parsed.n >= peekCounter(print.nextIds, parsed.counter))) {
      out.push({
        code: 'invalid-id',
        message:
          parsed.split !== ''
            ? `Id "${id}" in the print setups is a split piece; print setups have none`
            : `Print id "${id}" was never allocated (next is ${previewId(parsed.counter, peekCounter(print.nextIds, parsed.counter))})`,
        path,
        blockers: [id],
      });
    }
    if (seen.has(id)) {
      out.push({
        code: 'duplicate',
        message: `Id "${id}" is used twice in the print setups`,
        path,
        blockers: [id],
      });
    }
    seen.add(id);
  };

  print.setups.forEach((setup, si) => {
    const spath = ['print', 'setups', si];
    checkId(setup.id, [...spath, 'id']);
    for (const site of printThresholdExpressions(setup)) {
      checkExpression(site.expression, [...spath, ...site.path], variables, out);
    }
    setup.items.forEach((item, ii) => {
      const ipath = [...spath, 'items', ii];
      // In the order `printItemIds` lists them.
      const idPaths = [['id'], ['orientation', 'face', 'id']];
      printItemIds(item).forEach((id, k) => checkId(id, [...ipath, ...idPaths[k]!]));
      if (!partIds.has(item.part)) {
        out.push({
          code: 'dependency',
          message: `Print item ${item.id} of ${setup.id} prints part ${item.part}, which does not exist`,
          path: [...ipath, 'part'],
          blockers: [item.part],
        });
      }
      for (const site of printItemExpressions(item)) {
        checkExpression(site.expression, [...ipath, ...site.path], variables, out);
      }
    });
  });
}

/**
 * The drawings (M4 plan decision 7): drawing ids allocated by the document's `nextIds.drawing`
 * and unique; every id inside a drawing (sheets, views, dimensions, notes) allocated by the
 * drawing's own `nextIds` and used once in it; a view's part, assembly and exploded view exist;
 * no body listed twice in a view; a dimension's and a note's view is on the same sheet; a
 * dimension's references carry an instance path exactly when their view shows an assembly, and
 * the instance is in that assembly; every expression parses and names existing variables.
 *
 * Deliberately not checked: that a view's bodies, or a dimension's body, face, edge or vertex,
 * still exist. Those are model references, resolved by regen's drawing stage (`exact`, `lost`),
 * so editing or deleting the features that made them is never blocked by a drawing.
 */
function checkDrawings(
  doc: ManufaktureDocument,
  partIds: ReadonlySet<string>,
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const drawings = doc.drawings;
  if (drawings === undefined) return;
  const assemblies = new Map(
    doc.assemblies.map((a) => [
      a.id,
      {
        exploded: new Set((a.explodedViews ?? []).map((v) => v.id)),
      },
    ]),
  );
  checkUnique(
    drawings.map((d) => d.id),
    'Drawing id',
    (i) => ['drawings', i, 'id'],
    out,
  );
  drawings.forEach((drawing, di) => {
    checkAllocated(
      drawing.id,
      DRAWING_COUNTER,
      doc.nextIds,
      'Drawing',
      ['drawings', di, 'id'],
      out,
    );
    checkDrawing(drawing, di, partIds, assemblies, variables, out);
  });
}

function checkDrawing(
  drawing: Drawing,
  di: number,
  partIds: ReadonlySet<string>,
  assemblies: ReadonlyMap<string, { exploded: ReadonlySet<string> }>,
  variables: ReadonlySet<string>,
  out: CoreError[],
): void {
  const dpath = ['drawings', di];
  const seen = new Set<string>();
  const checkId = (id: string, path: readonly (string | number)[]) => {
    const parsed = parseAnyId(id);
    if (parsed && parsed.n >= peekCounter(drawing.nextIds, parsed.counter)) {
      out.push({
        code: 'invalid-id',
        message: `Id "${id}" in drawing ${drawing.id} was never allocated (next is ${previewId(parsed.counter, peekCounter(drawing.nextIds, parsed.counter))})`,
        path,
        blockers: [id],
      });
    }
    if (seen.has(id)) {
      out.push({
        code: 'duplicate',
        message: `Id "${id}" is used twice in drawing ${drawing.id}`,
        path,
        blockers: [id],
      });
    }
    seen.add(id);
  };

  drawing.sheets.forEach((sheet, si) => {
    const spath = [...dpath, 'sheets', si];
    checkId(sheet.id, [...spath, 'id']);
    for (const site of sheetExpressions(sheet)) {
      checkExpression(site.expression, [...spath, ...site.path], variables, out);
    }
    /** The assembly each view on the sheet shows, or `null` for a part view. */
    const views = new Map<string, string | null>();
    sheet.views.forEach((view, vi) => {
      const vpath = [...spath, 'views', vi];
      checkId(view.id, [...vpath, 'id']);
      const source = view.source;
      if ('part' in source) {
        views.set(view.id, null);
        if (!partIds.has(source.part)) {
          out.push({
            code: 'dependency',
            message: `View ${view.id} of ${drawing.id} shows part ${source.part}, which does not exist`,
            path: [...vpath, 'source', 'part'],
            blockers: [source.part],
          });
        }
        if (source.bodies !== undefined) {
          checkDuplicates(
            source.bodies,
            `the bodies view ${view.id} shows`,
            [...vpath, 'source', 'bodies'],
            out,
          );
        }
      } else {
        views.set(view.id, source.assembly);
        const assembly = assemblies.get(source.assembly);
        if (assembly === undefined) {
          out.push({
            code: 'dependency',
            message: `View ${view.id} of ${drawing.id} shows assembly ${source.assembly}, which does not exist`,
            path: [...vpath, 'source', 'assembly'],
            blockers: [source.assembly],
          });
        } else if (
          source.explodedView !== undefined &&
          !assembly.exploded.has(source.explodedView)
        ) {
          out.push({
            code: 'dependency',
            message: `View ${view.id} of ${drawing.id} shows exploded view ${source.explodedView}, which assembly ${source.assembly} does not have`,
            path: [...vpath, 'source', 'explodedView'],
            blockers: [source.explodedView],
          });
        }
      }
      for (const site of viewExpressions(view)) {
        checkExpression(site.expression, [...vpath, ...site.path], variables, out);
      }
    });

    sheet.dimensions.forEach((dimension, ki) => {
      const kpath = [...spath, 'dimensions', ki];
      checkId(dimension.id, [...kpath, 'id']);
      const shown = views.get(dimension.view);
      if (shown === undefined) {
        out.push({
          code: 'dependency',
          message: `Dimension ${dimension.id} of ${drawing.id} is in view ${dimension.view}, which is not on sheet ${sheet.id}`,
          path: [...kpath, 'view'],
          blockers: [dimension.view],
        });
        return;
      }
      dimension.refs.forEach((ref, ri) => {
        const rpath = [...kpath, 'refs', ri];
        if (shown === null) {
          if (ref.instance !== undefined) {
            out.push({
              code: 'kind-mismatch',
              message: `Dimension ${dimension.id} of ${drawing.id} names an instance, but view ${dimension.view} shows a part`,
              path: [...rpath, 'instance'],
            });
          }
          return;
        }
        if (ref.instance === undefined || ref.instance.length !== 1) {
          out.push({
            code: 'kind-mismatch',
            message: `Dimension ${dimension.id} of ${drawing.id} is in assembly view ${dimension.view}, so each reference names the one instance it is on`,
            path: ref.instance === undefined ? rpath : [...rpath, 'instance'],
          });
        }
        // Whether the instance still exists is not checked: dimensions never block model edits,
        // so one on a deleted instance stays valid and regen reports it reference-lost.
      });
    });

    sheet.notes.forEach((note, ni) => {
      const npath = [...spath, 'notes', ni];
      checkId(note.id, [...npath, 'id']);
      if (note.view !== undefined && !views.has(note.view)) {
        out.push({
          code: 'dependency',
          message: `Note ${note.id} of ${drawing.id} is attached to view ${note.view}, which is not on sheet ${sheet.id}`,
          path: [...npath, 'view'],
          blockers: [note.view],
        });
      }
    });
  });
}

/** `<counter>#n` for an assembly-level counter, `<prefix>n` for a reference prefix. */
function previewId(counter: string, n: number): string {
  return counter.length === 1 ? `${counter}${n}` : `${counter}#${n}`;
}

/** Every semantic problem in a schema-valid document; empty when it is valid. */
export function validateDocument(doc: ManufaktureDocument): CoreError[] {
  const out: CoreError[] = [];
  const variables = checkVariables(doc.variables, out);
  const fontIds = new Set<string>();
  doc.fonts.forEach((font, i) => {
    checkAllocated(font.id, FONT_COUNTER, doc.nextIds, 'Font', ['fonts', i, 'id'], out);
    fontIds.add(font.id);
  });
  checkUnique(
    doc.fonts.map((f) => f.id),
    'Font id',
    (i) => ['fonts', i, 'id'],
    out,
  );
  const partIds = new Set<string>();
  doc.parts.forEach((part, pi) => {
    const parsed = parseFeatureId(part.id);
    if (parsed?.counter === PART_COUNTER && parsed.n >= peekCounter(doc.nextIds, PART_COUNTER)) {
      out.push({
        code: 'invalid-id',
        message: `Part id "${part.id}" was never allocated (next part id is ${peekCounter(doc.nextIds, PART_COUNTER)})`,
        path: ['parts', pi, 'id'],
      });
    }
    if (partIds.has(part.id)) {
      out.push({
        code: 'duplicate',
        message: `Part id "${part.id}" is used twice`,
        path: ['parts', pi, 'id'],
      });
    }
    partIds.add(part.id);
    checkPart(part, pi, variables, fontIds, out);
  });
  checkConfigurations(doc, variables, out);
  checkUnique(
    doc.assemblies.map((a) => a.id),
    'Assembly id',
    (i) => ['assemblies', i, 'id'],
    out,
  );
  const rowIds = new Set((doc.configurations?.rows ?? []).map((r) => r.id));
  doc.assemblies.forEach((assembly, ai) => {
    checkAllocated(
      assembly.id,
      ASSEMBLY_COUNTER,
      doc.nextIds,
      'Assembly',
      ['assemblies', ai, 'id'],
      out,
    );
    checkAssembly(assembly, ai, partIds, rowIds, variables, out);
  });
  checkPrint(doc.print, partIds, variables, out);
  checkDrawings(doc, partIds, variables, out);
  return out;
}

/** `validateDocument` as a result: the first problem is the error, all of them its `issues`. */
export function checkDocument(doc: ManufaktureDocument): CoreResult<ManufaktureDocument> {
  const issues = validateDocument(doc);
  if (issues.length === 0) return ok(doc);
  const first = issues[0]!;
  return { ok: false, error: { ...first, issues } };
}
