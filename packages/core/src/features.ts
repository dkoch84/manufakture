import type {
  ConstraintKind,
  Feature,
  FeatureKind,
  Reference,
  SketchConstraint,
  SketchEntity,
  StoredExpression,
} from './schema';
import { DIMENSION_KINDS, FEATURE_KINDS } from './schema';
import { FEATURE_ID_PATTERN } from './ids';

/**
 * Generic views of a feature: the geometry references it holds, the features it depends on and
 * the expressions it contains. Validation, the command layer and regen all use these, so each
 * feature kind is described once.
 */

/** Every `Reference` a feature holds, in a stable order. */
export function featureReferences(feature: Feature): Reference[] {
  switch (feature.kind) {
    case 'sketch':
      return feature.plane.type === 'face' ? [feature.plane.face] : [];
    case 'extrude':
      return feature.extent.type === 'upToFace' ? [feature.extent.face] : [];
    case 'revolve':
      return feature.axis.type === 'edge' ? [feature.axis.edge] : [];
    case 'fillet':
    case 'chamfer':
      return [...feature.edges];
    case 'shell':
      return [...feature.faces];
    case 'hole':
      return [];
    case 'pattern':
      return [feature.layout.type === 'linear' ? feature.layout.direction : feature.layout.axis];
    case 'mirror':
      return [feature.plane];
    case 'extension':
      return [...feature.references];
    case 'import':
    case 'derived':
      return [];
  }
}

/** Features named directly by id (profiles, hole sketches, patterned features). */
export function explicitDependencies(feature: Feature): string[] {
  switch (feature.kind) {
    case 'extrude':
    case 'revolve':
      return [feature.profile.sketch];
    case 'hole':
      return [feature.sketch];
    case 'pattern':
    case 'mirror':
      return [...feature.features];
    case 'extension':
      return [...feature.dependsOn];
    default:
      return [];
  }
}

const KIND_ALTERNATION = FEATURE_KINDS.join('|');
/** A feature id starting a face name at this position: `extrude#1:cap:end`. */
const NAME_FEATURE_ID = new RegExp(`(?<![A-Za-z0-9#])((?:${KIND_ALTERNATION})#[1-9][0-9]*):`, 'y');
/** What follows `<id>:` when the rest of a name is a name in another document (M2 decision 6). */
const FROM = 'from/';

/**
 * One pass over a face name, left to right, keeping a stack of open groups: for each level, whether
 * the current member is in a source-name tail (after `<id>:from/`) and whether the whole group is
 * (it opened inside such a tail). `+` and `&` end a member at their level; `(` opens a level and
 * `)` closes it (a stray `)` at the top is ignored, an unclosed `(` runs to the end). Linear in
 * the name's length, with no recursion, so no input can exhaust the stack.
 */
function scanName(name: string, out: Set<string>): void {
  // skip[d]: the member at depth d is in a source tail; locked[d]: the group itself is.
  const skip: boolean[] = [false];
  const locked: boolean[] = [false];
  let d = 0;
  let i = 0;
  while (i < name.length) {
    const c = name[i];
    if (c === '(') {
      d++;
      skip[d] = skip[d - 1]!;
      locked[d] = skip[d - 1]!;
      i++;
    } else if (c === ')') {
      if (d > 0) d--;
      i++;
    } else if (c === '+' || c === '&') {
      if (!locked[d]) skip[d] = false;
      i++;
    } else if (!skip[d] && c! >= 'a' && c! <= 'z') {
      NAME_FEATURE_ID.lastIndex = i;
      const m = NAME_FEATURE_ID.exec(name);
      if (m) {
        out.add(m[1]!);
        i += m[0].length;
        if (name.startsWith(FROM, i)) skip[d] = true;
      } else i++;
    } else i++;
  }
}

/**
 * Feature ids that a face name mentions, in order of appearance, without duplicates. Names nest
 * (merges `(A+B)`, corners `fillet#3:corner:A&B&C`, copies `pattern#2:i3/A`), so every feature id
 * starting a name counts, not only the first; but in each merge or corner member, what follows
 * `<id>:from/` is a name in a derived part's source document, so only `<id>` counts there:
 * `derived#1:from/extrude#1:cap:end` gives `derived#1` alone.
 */
export function featureIdsInName(name: string): string[] {
  const out = new Set<string>();
  scanName(name, out);
  return [...out];
}

/**
 * The feature that creates a body: the leading feature id of its body id (decision 1 of the M2
 * plan). `extrude#3` gives `extrude#3`, `pattern#2:i3` gives `pattern#2`, and a derived body
 * `derived#1:from/pattern#2:i3` gives `derived#1`: everything after the first `:` belongs to
 * the creating feature (an instance suffix, or a name in another document), so it is never read
 * for feature ids. `undefined` when the id does not start with a feature id.
 */
export function bodyCreator(bodyId: string): string | undefined {
  const colon = bodyId.indexOf(':');
  const head = colon < 0 ? bodyId : bodyId.slice(0, colon);
  return FEATURE_ID_PATTERN.test(head) ? head : undefined;
}

/** The body ids a feature's `scope` lists; empty when it has none (every body). */
export function featureScope(feature: Feature): readonly string[] {
  return 'scope' in feature && feature.scope !== undefined ? feature.scope : [];
}

/** Every face name a reference stores (its faces and, for edges, its end faces). */
export function referenceNames(reference: Reference): string[] {
  const r = reference.ref;
  return 'face' in r ? [r.face] : [...r.faces, ...(r.ends ?? [])];
}

/**
 * Every feature this feature depends on: the ones it names by id, the ones whose faces its
 * references name, and the creators of the bodies in its `scope`. Sorted, without duplicates,
 * never including itself.
 */
export function featureDependencies(feature: Feature): string[] {
  const out = new Set(explicitDependencies(feature));
  for (const body of featureScope(feature)) {
    const creator = bodyCreator(body);
    if (creator !== undefined) out.add(creator);
  }
  for (const reference of featureReferences(feature)) {
    for (const name of referenceNames(reference)) {
      for (const id of featureIdsInName(name)) out.add(id);
    }
  }
  out.delete(feature.id);
  return [...out].sort();
}

/** What an expression must evaluate to. `any` is inferred (extension expressions). */
export type ExpressionKind = 'length' | 'angle' | 'number' | 'any';

export interface ExpressionSite {
  /** Path from the feature to the expression, e.g. `['extent', 'distance']`. */
  readonly path: readonly (string | number)[];
  readonly expression: StoredExpression;
  readonly expected: ExpressionKind;
}

/** Every expression in a feature, with the kind its field expects. */
export function featureExpressions(feature: Feature): ExpressionSite[] {
  const out: ExpressionSite[] = [];
  const add = (
    path: readonly (string | number)[],
    expression: StoredExpression | undefined,
    expected: ExpressionKind,
  ) => {
    if (expression) out.push({ path, expression, expected });
  };
  switch (feature.kind) {
    case 'sketch':
      feature.constraints.forEach((c, i) => {
        if ('value' in c) {
          add(
            ['constraints', i, 'value'],
            c.value,
            DIMENSION_KINDS[c.kind as keyof typeof DIMENSION_KINDS],
          );
        }
      });
      break;
    case 'extrude':
      if (feature.extent.type === 'blind' || feature.extent.type === 'symmetric') {
        add(['extent', 'distance'], feature.extent.distance, 'length');
      }
      add(['draft'], feature.draft, 'angle');
      break;
    case 'revolve':
      add(['angle'], feature.angle, 'angle');
      break;
    case 'fillet':
      add(['radius'], feature.radius, 'length');
      break;
    case 'chamfer':
      add(['distance'], feature.distance, 'length');
      add(['secondDistance'], feature.secondDistance, 'length');
      add(['angle'], feature.angle, 'angle');
      break;
    case 'shell':
      add(['thickness'], feature.thickness, 'length');
      break;
    case 'hole':
      add(['diameter'], feature.diameter, 'length');
      if (feature.extent.type === 'blind') add(['extent', 'depth'], feature.extent.depth, 'length');
      if (feature.head.type === 'counterbore') {
        add(['head', 'diameter'], feature.head.diameter, 'length');
        add(['head', 'depth'], feature.head.depth, 'length');
      } else if (feature.head.type === 'countersink') {
        add(['head', 'diameter'], feature.head.diameter, 'length');
        add(['head', 'angle'], feature.head.angle, 'angle');
      }
      break;
    case 'pattern':
      add(['layout', 'count'], feature.layout.count, 'number');
      if (feature.layout.type === 'linear') {
        add(['layout', 'spacing'], feature.layout.spacing, 'length');
      } else {
        add(['layout', 'angle'], feature.layout.angle, 'angle');
      }
      break;
    case 'mirror':
    case 'import':
      break;
    case 'derived':
      for (const i of [0, 1, 2]) {
        add(['placement', 'translation', i], feature.placement.translation[i], 'length');
      }
      for (const i of [0, 1, 2]) {
        add(['placement', 'rotation', i], feature.placement.rotation[i], 'angle');
      }
      break;
    case 'extension':
      for (const key of Object.keys(feature.expressions).sort()) {
        add(['expressions', key], feature.expressions[key], 'any');
      }
      break;
  }
  return out;
}

export function sketchEntities(feature: Feature): readonly SketchEntity[] {
  return feature.kind === 'sketch' ? feature.entities : [];
}

export function sketchConstraints(feature: Feature): readonly SketchConstraint[] {
  return feature.kind === 'sketch' ? feature.constraints : [];
}

/** Every id a feature owns inside itself: sketch entities, constraints and references. */
export function featureSubIds(feature: Feature): string[] {
  return [
    ...sketchEntities(feature).map((e) => e.id),
    ...sketchConstraints(feature).map((c) => c.id),
    ...featureReferences(feature).map((r) => r.id),
  ];
}

/** Display name for a new feature: `Extrude 3` for `extrude#3`. */
export function defaultFeatureName(kind: FeatureKind, id: string): string {
  const n = id.slice(id.indexOf('#') + 1);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${n}`;
}

/** One place a sketch constraint names sketch geometry. */
export interface ConstraintTarget {
  /** The constraint field: `a`, `b`, `line`, `point`, `on`, `entity` or `center`. */
  readonly field: string;
  /** An entity id of the same sketch, or a built-in (`@origin`, `@x-axis`, `@y-axis`). */
  readonly entity: string;
  /** For a point reference: which vertex (`start`, `end`, `center`), if any. */
  readonly at?: string;
  /** A point reference (`{ entity, at? }`) rather than a whole curve. */
  readonly isPoint: boolean;
}

/** Every entity a constraint names, in field order. */
export function constraintTargets(constraint: SketchConstraint): ConstraintTarget[] {
  const out: ConstraintTarget[] = [];
  for (const [field, v] of Object.entries(constraint)) {
    if (field === 'id' || field === 'kind' || field === 'value' || field === 'at') continue;
    if (typeof v === 'string') {
      out.push({ field, entity: v, isPoint: false });
    } else if (v && typeof v === 'object' && 'entity' in v) {
      const p = v as { entity: string; at?: string };
      out.push(
        p.at === undefined
          ? { field, entity: p.entity, isPoint: true }
          : { field, entity: p.entity, at: p.at, isPoint: true },
      );
    }
  }
  return out;
}

/** Whether a constraint kind holds a dimension value. */
export function isDimensionKind(kind: ConstraintKind): kind is keyof typeof DIMENSION_KINDS {
  return kind in DIMENSION_KINDS;
}
