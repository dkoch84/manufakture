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
  featureDependencies,
  featureExpressions,
  featureScope,
  featureSubIds,
} from './features';
import { PART_COUNTER, parseFeatureId, parseSubId, peekCounter } from './ids';
import { fail, ok, type CoreError, type CoreResult } from './result';
import {
  SKETCH_ORIGIN,
  type Feature,
  type ManufaktureDocument,
  type Part,
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
};

/**
 * Referential checks inside one sketch: every constraint names entities of this sketch (or a
 * built-in), and every point reference names a vertex its entity has. Whether a constraint makes
 * geometric sense (parallel circles) is the sketch package's call, reported when it solves.
 */
function checkSketch(
  sketch: SketchFeature,
  path: readonly (string | number)[],
  out: CoreError[],
): void {
  const entities = new Map(sketch.entities.map((e) => [e.id, e]));
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

/**
 * Why a feature cannot create the body `bodyId` names, or `undefined` when it can. Extrude,
 * revolve and import make one body under their own id with a `new` operation, and with `add`
 * when the solid touches no body (M2 plan, decision 2: known only after regen, which reports
 * props on an `add` that merged as lost). A pattern or mirror of bodies makes its copies under
 * an instance suffix (`pattern#2:i3`, `mirror#1:image`); which suffixes exist is a regen result.
 */
export function bodyCreationProblem(creator: Feature, bodyId: string): string | undefined {
  const suffix = bodyId.length > creator.id.length;
  switch (creator.kind) {
    case 'extrude':
    case 'revolve':
    case 'import':
      if (creator.operation !== 'new' && creator.operation !== 'add') {
        return `${creator.id} is a "${creator.operation}" ${creator.kind}, which makes no body`;
      }
      return suffix ? `${creator.id} makes one body, named "${creator.id}"` : undefined;
    case 'pattern':
    case 'mirror':
      if (creator.body !== true) {
        return `${creator.id} repeats features, not bodies, so it makes no body`;
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
  const problem = bodyCreationProblem(part.features[ci]!, bodyId);
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

function checkPart(part: Part, pi: number, variables: ReadonlySet<string>, out: CoreError[]): void {
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
    if (f.kind === 'sketch') checkSketch(f, fpath, out);
    for (const site of featureExpressions(f))
      checkExpression(site.expression, [...fpath, ...site.path], variables, out);
  });

  const bodies = part.bodies.map((b) => b.id);
  checkDuplicates(bodies, `the bodies of part ${part.id}`, [...ppath, 'bodies'], out);
  bodies.forEach((body, bi) =>
    checkBodyId(part, index, body, undefined, [...ppath, 'bodies', bi, 'id'], out),
  );
}

/** Every semantic problem in a schema-valid document; empty when it is valid. */
export function validateDocument(doc: ManufaktureDocument): CoreError[] {
  const out: CoreError[] = [];
  const variables = checkVariables(doc.variables, out);
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
    checkPart(part, pi, variables, out);
  });
  return out;
}

/** `validateDocument` as a result: the first problem is the error, all of them its `issues`. */
export function checkDocument(doc: ManufaktureDocument): CoreResult<ManufaktureDocument> {
  const issues = validateDocument(doc);
  if (issues.length === 0) return ok(doc);
  const first = issues[0]!;
  return { ok: false, error: { ...first, issues } };
}
