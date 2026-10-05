import type {
  Assembly,
  CamData,
  CamDepth,
  CamEntry,
  CamLead,
  CamOperation,
  CamSetup,
  CamTool,
  ConstraintKind,
  DerivedSource,
  Dimension,
  FaceReference,
  Drawing,
  DrawingView,
  ExplodedView,
  ExplodeStep,
  Feature,
  FeatureKind,
  InstanceSource,
  Mate,
  MateConnector,
  PartInstanceSource,
  PrintItem,
  PrintSetup,
  Reference,
  ScriptedFeature,
  Sheet,
  SketchConstraint,
  SketchEntity,
  StoredExpression,
} from './schema';
import { DIMENSION_KINDS } from './schema';
import { featureIdsInName } from './names';
import { FEATURE_ID_PATTERN } from './ids';

// The name parser owns it (names.ts, loadable without the schema); exported here as before.
export { featureIdsInName };

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
    case 'thread':
      return feature.start === undefined ? [feature.face] : [feature.face, feature.start];
    case 'scripted':
      return scriptedReferences(feature);
  }
}

/**
 * The references of a scripted feature's `reference` parameters: by parameter name in code-unit
 * order, then in each parameter's order, so the list does not depend on how `params` was built.
 */
export function scriptedReferences(feature: ScriptedFeature): Reference[] {
  const out: Reference[] = [];
  for (const name of Object.keys(feature.params).sort()) {
    const value = feature.params[name]!;
    if (value.kind === 'reference') out.push(...value.references);
  }
  return out;
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
    case 'scripted':
      return [...feature.dependsOn];
    default:
      return [];
  }
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

/**
 * An operation id a script gives each call (`ctx.extrude('boss', ...)`, ADR 0010 decision 6): a
 * lower-case letter, then letters, digits and `_`, at most 64 characters. It names what the
 * operation makes, so it never holds a character that structures names.
 */
export const SCRIPT_OPERATION_ID_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;

/**
 * The prefix of every face a scripted feature's operation makes: `<feature id>:<operation id>/`
 * (`scripted#2:boss/`), followed by the kernel's name for it without a feature id
 * (`scripted#2:boss/cap:end`, `scripted#2:boss/side:s1`, where `s1` is the script's own local
 * id). Core's name parser reads the prefix (`parseName`), so sync rewrites the feature id and
 * never the operation or local ids.
 */
export function scriptOperationPrefix(featureId: string, operationId: string): string {
  return `${featureId}:${operationId}/`;
}

/**
 * The scripted feature and operation a face name was born in (`scripted#2:boss/cap:end` gives
 * `scripted#2` and `boss`), or null when the name does not start with an operation prefix (an
 * operation id longer than `SCRIPT_OPERATION_ID_PATTERN` allows is not one).
 */
export function scriptOperationOf(name: string): { featureId: string; operationId: string } | null {
  const m = /^(scripted#[1-9][0-9]*):([a-z][A-Za-z0-9_]{0,63})\//.exec(name);
  return m === null ? null : { featureId: m[1]!, operationId: m[2]! };
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

/**
 * What an expression must evaluate to. `any` is inferred (extension expressions, and scripted
 * feature parameters, whose kind the script declares).
 */
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
      // A text's size and spacing (since version 9), and an SVG outline's scale (since version
      // 13): evaluated by regen, never by the solver.
      feature.entities.forEach((e, i) => {
        if (e.kind !== 'outline') return;
        if (e.source.kind === 'svg') {
          add(['entities', i, 'source', 'scale'], e.source.scale, 'number');
          return;
        }
        add(['entities', i, 'source', 'size'], e.source.size, 'length');
        add(['entities', i, 'source', 'letterSpacing'], e.source.letterSpacing, 'length');
        add(['entities', i, 'source', 'lineSpacing'], e.source.lineSpacing, 'number');
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
    case 'thread':
      if (feature.length !== 'full') add(['length'], feature.length, 'length');
      add(['clearance'], feature.clearance, 'length');
      break;
    case 'scripted':
      for (const key of Object.keys(feature.params).sort()) {
        const value = feature.params[key]!;
        if (value.kind === 'expression')
          add(['params', key, 'expression'], value.expression, 'any');
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

// ---------------------------------------------------------------------------------------------
// Assemblies (since version 7): generic views of mates and instances, like the ones above for
// features, so validation, commands and regen describe each once.

/** Whether an instance shows a pinned part of another document rather than a part of this one. */
export function isPinnedSource(source: InstanceSource): source is DerivedSource {
  return !('part' in source);
}

/** The part of this document an instance shows, or `undefined` for a pinned source. */
export function instancePart(source: InstanceSource): string | undefined {
  return isPinnedSource(source) ? undefined : (source as PartInstanceSource).part;
}

/** A mate's two connectors, `a` then `b`. */
export function mateConnectors(mate: Mate): readonly [MateConnector, MateConnector] {
  return [mate.a, mate.b];
}

/** Every id a mate owns: its own, its connectors' (`mc#n`) and their references' (`r<n>`). */
export function mateIds(mate: Mate): string[] {
  return [mate.id, mate.a.id, mate.a.origin.id, mate.b.id, mate.b.origin.id];
}

/** The instances a mate connects, `a`'s then `b`'s. */
export function mateInstances(mate: Mate): [string, string] {
  return [mate.a.instance, mate.b.instance];
}

/** Every expression in a mate (connector offsets and limits), with the kind its field expects. */
export function mateExpressions(mate: Mate): ExpressionSite[] {
  const out: ExpressionSite[] = [];
  for (const side of ['a', 'b'] as const) {
    const offset = mate[side].offset;
    if (offset === undefined) continue;
    for (const i of [0, 1, 2]) {
      out.push({
        path: [side, 'offset', 'translation', i],
        expression: offset.translation[i]!,
        expected: 'length',
      });
    }
    for (const i of [0, 1, 2]) {
      out.push({
        path: [side, 'offset', 'rotation', i],
        expression: offset.rotation[i]!,
        expected: 'angle',
      });
    }
  }
  const expected: ExpressionKind = mate.kind === 'revolute' ? 'angle' : 'length';
  for (const bound of ['min', 'max'] as const) {
    const expression = mate.limits?.[bound];
    if (expression !== undefined) out.push({ path: ['limits', bound], expression, expected });
  }
  return out;
}

/** The mates of an assembly that connect instance `instanceId`, by mate id. */
export function instanceMates(assembly: Assembly, instanceId: string): string[] {
  return assembly.mates
    .filter((m) => m.a.instance === instanceId || m.b.instance === instanceId)
    .map((m) => m.id);
}

// ---------------------------------------------------------------------------------------------
// Print setups (since version 8): generic views of setups and items, as above for mates.

/** Every id a print item owns: its own and its `layFlat` face reference's (`r<n>`). */
export function printItemIds(item: PrintItem): string[] {
  return item.orientation.kind === 'layFlat' ? [item.id, item.orientation.face.id] : [item.id];
}

/** Every id a print setup owns: its own, then each item's (`printItemIds`), in item order. */
export function printSetupIds(setup: PrintSetup): string[] {
  return [setup.id, ...setup.items.flatMap(printItemIds)];
}

/** The order thresholds are listed in, with the kind each one expects. */
const THRESHOLDS = [
  ['overhang', 'angle'],
  ['minWall', 'length'],
  ['minGap', 'length'],
  ['minHole', 'length'],
  ['teardrop', 'length'],
] as const;

/** A setup's threshold expressions, with paths from the setup (`['thresholds', 'minWall']`). */
export function printThresholdExpressions(setup: PrintSetup): ExpressionSite[] {
  const out: ExpressionSite[] = [];
  for (const [key, expected] of THRESHOLDS) {
    const expression = setup.thresholds?.[key];
    if (expression !== undefined) out.push({ path: ['thresholds', key], expression, expected });
  }
  return out;
}

/**
 * An item's orientation expressions (all angles), with paths from the item
 * (`['orientation', 'turn']`, `['orientation', 'x']`).
 */
export function printItemExpressions(item: PrintItem): ExpressionSite[] {
  const o = item.orientation;
  if (o.kind === 'layFlat') {
    return o.turn === undefined
      ? []
      : [{ path: ['orientation', 'turn'], expression: o.turn, expected: 'angle' }];
  }
  if (o.kind === 'rotate') {
    return (['x', 'y', 'z'] as const).map((axis) => ({
      path: ['orientation', axis],
      expression: o[axis],
      expected: 'angle' as const,
    }));
  }
  return [];
}

/**
 * Every expression in a setup, with paths from the setup: thresholds, then each item's
 * (`['items', 2, 'orientation', 'turn']`).
 */
export function printSetupExpressions(setup: PrintSetup): ExpressionSite[] {
  return [
    ...printThresholdExpressions(setup),
    ...setup.items.flatMap((item, i) =>
      printItemExpressions(item).map((site) => ({ ...site, path: ['items', i, ...site.path] })),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// Exploded views and drawings (since version 12): generic views, as above for mates and setups.

/** Every id an exploded view owns: its own, then its steps' (`step#n`), in step order. */
export function explodedViewIds(view: ExplodedView): string[] {
  return [view.id, ...view.steps.map((s) => s.id)];
}

/** The instances a step names: those it moves, then the one its direction is read from, if any. */
export function explodeStepInstances(step: ExplodeStep): string[] {
  return 'instance' in step.direction
    ? [...step.instances, step.direction.instance]
    : [...step.instances];
}

/** An exploded view's expressions (each step's distance), with paths from the view. */
export function explodedViewExpressions(view: ExplodedView): ExpressionSite[] {
  return view.steps.map((step, i) => ({
    path: ['steps', i, 'distance'],
    expression: step.distance,
    expected: 'length' as const,
  }));
}

/**
 * The exploded views of an assembly that move instance `instanceId` or read a direction from it,
 * by id.
 */
export function instanceExplodedViews(assembly: Assembly, instanceId: string): string[] {
  return (assembly.explodedViews ?? [])
    .filter((v) => v.steps.some((s) => explodeStepInstances(s).includes(instanceId)))
    .map((v) => v.id);
}

/** A sheet's size expressions (a custom size's sides), with paths from the sheet. */
export function sheetExpressions(sheet: Sheet): ExpressionSite[] {
  if (typeof sheet.size === 'string') return [];
  return [
    { path: ['size', 'width'], expression: sheet.size.width, expected: 'length' },
    { path: ['size', 'height'], expression: sheet.size.height, expected: 'length' },
  ];
}

/** A view's expressions (its scale, and a section's offset), with paths from the view. */
export function viewExpressions(view: DrawingView): ExpressionSite[] {
  const out: ExpressionSite[] = [
    { path: ['scale', 'paper'], expression: view.scale.paper, expected: 'length' },
    { path: ['scale', 'model'], expression: view.scale.model, expected: 'length' },
  ];
  const section = view.options.section;
  if (section !== undefined) {
    out.push({
      path: ['options', 'section', 'offset'],
      expression: section.offset,
      expected: 'length',
    });
  }
  return out;
}

/**
 * Every expression in a drawing, with paths from the drawing: per sheet, its size, then its
 * views' (`['sheets', 0, 'views', 2, 'scale', 'paper']`).
 */
export function drawingExpressions(drawing: Drawing): ExpressionSite[] {
  return drawing.sheets.flatMap((sheet, si) => [
    ...sheetExpressions(sheet).map((site) => ({ ...site, path: ['sheets', si, ...site.path] })),
    ...sheet.views.flatMap((view, vi) =>
      viewExpressions(view).map((site) => ({
        ...site,
        path: ['sheets', si, 'views', vi, ...site.path],
      })),
    ),
  ]);
}

/** Every id a sheet owns: its own, then its views', dimensions' and notes'. */
export function sheetIds(sheet: Sheet): string[] {
  return [
    sheet.id,
    ...sheet.views.map((v) => v.id),
    ...sheet.dimensions.map((d) => d.id),
    ...sheet.notes.map((n) => n.id),
  ];
}

/** The instance ids a dimension's references name (the first of each instance path). */
export function dimensionInstances(dimension: Dimension): string[] {
  const out: string[] = [];
  for (const ref of dimension.refs) {
    if (ref.instance !== undefined) out.push(ref.instance[0]!);
  }
  return out;
}

/** Visits every view of every drawing, with where it is. */
export function forEachView(
  drawings: readonly Drawing[] | undefined,
  visit: (view: DrawingView, sheet: Sheet, drawing: Drawing) => void,
): void {
  for (const drawing of drawings ?? []) {
    for (const sheet of drawing.sheets) for (const view of sheet.views) visit(view, sheet, drawing);
  }
}

// ---------------------------------------------------------------------------------------------
// CAM (since version 14; ADR 0014): generic views of tools, setups and operations, as above for
// print setups. Validation, commands, variables and changes use these, so each kind is described
// once.

/**
 * What a CAM expression must evaluate to: core's kinds plus the feed rate and spindle speed of
 * `@manufakture/units` (T5.1a). Kept apart from `ExpressionKind` so code that evaluates feature
 * expressions keeps working unchanged.
 */
export type CamExpressionKind = 'length' | 'angle' | 'number' | 'feed' | 'spindleSpeed';

export interface CamExpressionSite {
  /** Path from the tool, setup or operation to the expression (`['depth', 'depth']`). */
  readonly path: readonly (string | number)[];
  readonly expression: StoredExpression;
  readonly expected: CamExpressionKind;
}

function camSites(): {
  out: CamExpressionSite[];
  add: (
    path: readonly (string | number)[],
    expression: StoredExpression | undefined,
    expected: CamExpressionKind,
  ) => void;
} {
  const out: CamExpressionSite[] = [];
  return {
    out,
    add: (path, expression, expected) => {
      if (expression !== undefined) out.push({ path, expression, expected });
    },
  };
}

/** A tool's expressions: its sizes, then each preset's (`['presets', 0, 'feed']`). */
export function camToolExpressions(tool: CamTool): CamExpressionSite[] {
  const { out, add } = camSites();
  add(['diameter'], tool.diameter, 'length');
  add(['fluteLength'], tool.fluteLength, 'length');
  add(['cornerRadius'], tool.cornerRadius, 'length');
  add(['angle'], tool.angle, 'angle');
  add(['tipDiameter'], tool.tipDiameter, 'length');
  tool.presets.forEach((p, i) => {
    add(['presets', i, 'spindle'], p.spindle, 'spindleSpeed');
    add(['presets', i, 'feed'], p.feed, 'feed');
    add(['presets', i, 'plunge'], p.plunge, 'feed');
    add(['presets', i, 'stepdown'], p.stepdown, 'length');
    add(['presets', i, 'stepover'], p.stepover, 'number');
  });
  return out;
}

/** A setup's own expressions (its stock and heights, not its operations'), with paths from it. */
export function camSetupOwnExpressions(setup: CamSetup): CamExpressionSite[] {
  const { out, add } = camSites();
  const stock = setup.stock;
  if (stock.kind === 'fromBody') {
    for (const key of ['xMin', 'xMax', 'yMin', 'yMax', 'top', 'bottom'] as const) {
      add(['stock', 'margins', key], stock.margins[key], 'length');
    }
  } else {
    for (const key of ['x', 'y', 'z'] as const)
      add(['stock', 'size', key], stock.size[key], 'length');
    for (const key of ['x', 'y', 'z'] as const) {
      add(['stock', 'offset', key], stock.offset[key], 'length');
    }
  }
  add(['heights', 'clearance'], setup.heights.clearance, 'length');
  add(['heights', 'retract'], setup.heights.retract, 'length');
  return out;
}

function depthSites(add: ReturnType<typeof camSites>['add'], depth: CamDepth | undefined): void {
  if (depth?.kind === 'blind') add(['depth', 'depth'], depth.depth, 'length');
  else if (depth?.kind === 'through') add(['depth', 'extra'], depth.extra, 'length');
}

function entrySites(add: ReturnType<typeof camSites>['add'], entry: CamEntry): void {
  if (entry.kind === 'ramp') add(['entry', 'angle'], entry.angle, 'angle');
  if (entry.kind === 'helix') {
    add(['entry', 'angle'], entry.angle, 'angle');
    add(['entry', 'radius'], entry.radius, 'length');
  }
}

function leadSites(
  add: ReturnType<typeof camSites>['add'],
  key: 'leadIn' | 'leadOut',
  lead: CamLead,
): void {
  if (lead.kind === 'line') add([key, 'length'], lead.length, 'length');
  if (lead.kind === 'arc') add([key, 'radius'], lead.radius, 'length');
}

/**
 * Every expression of an operation with the kind its field expects, for regen-style evaluation
 * (M5 plan, T5.1b): its feeds, then its kind's fields, with paths from the operation.
 */
export function camExpressions(op: CamOperation): CamExpressionSite[] {
  const { out, add } = camSites();
  add(['feeds', 'spindle'], op.feeds?.spindle, 'spindleSpeed');
  for (const key of ['cut', 'plunge', 'ramp', 'lead'] as const) {
    add(['feeds', key], op.feeds?.[key], 'feed');
  }
  switch (op.kind) {
    case 'facing':
      add(['depth'], op.depth, 'length');
      add(['stepdown'], op.stepdown, 'length');
      add(['stepover'], op.stepover, 'number');
      add(['angle'], op.angle, 'angle');
      break;
    case 'profile':
      depthSites(add, op.depth);
      add(['stepdown'], op.stepdown, 'length');
      add(['finishAllowance'], op.finishAllowance, 'length');
      add(['tabs', 'count'], op.tabs?.count, 'number');
      add(['tabs', 'width'], op.tabs?.width, 'length');
      add(['tabs', 'height'], op.tabs?.height, 'length');
      entrySites(add, op.entry);
      leadSites(add, 'leadIn', op.leadIn);
      leadSites(add, 'leadOut', op.leadOut);
      break;
    case 'pocket':
      depthSites(add, op.depth);
      add(['stepdown'], op.stepdown, 'length');
      add(['stepover'], op.stepover, 'number');
      add(['finishAllowance'], op.finishAllowance, 'length');
      entrySites(add, op.entry);
      add(['finishStepdown'], op.finishStepdown, 'length');
      add(['floorAllowance'], op.floorAllowance, 'length');
      break;
    case 'drill':
      depthSites(add, op.depth);
      add(['peck'], op.peck, 'length');
      add(['dwell'], op.dwell, 'number');
      break;
    case 'vcarve': {
      add(['maxDepth'], op.maxDepth, 'length');
      add(['stepdown'], op.stepdown, 'length');
      add(['flatStepover'], op.flatStepover, 'length');
      const c = op.clearing;
      if (c) {
        add(['clearing', 'stepdown'], c.stepdown, 'length');
        add(['clearing', 'stepover'], c.stepover, 'number');
        if (c.entry) {
          if (c.entry.kind !== 'plunge')
            add(['clearing', 'entry', 'angle'], c.entry.angle, 'angle');
          if (c.entry.kind === 'helix') {
            add(['clearing', 'entry', 'radius'], c.entry.radius, 'length');
          }
        }
        add(['clearing', 'feeds', 'spindle'], c.feeds?.spindle, 'spindleSpeed');
        for (const key of ['cut', 'plunge', 'ramp', 'lead'] as const) {
          add(['clearing', 'feeds', key], c.feeds?.[key], 'feed');
        }
      }
      break;
    }
    case 'surface3d':
      add(['stepover'], op.stepover, 'length');
      add(['angle'], op.angle, 'angle');
      add(['allowance'], op.allowance, 'length');
      add(['tolerance'], op.tolerance, 'length');
      add(['sampling'], op.sampling, 'length');
      add(['stepdown'], op.stepdown, 'length');
      if (op.entry) entrySites(add, op.entry);
      add(['sliceCell'], op.sliceCell, 'length');
      break;
  }
  return out;
}

/**
 * Every expression in a setup, with paths from the setup: its own (`camSetupOwnExpressions`),
 * then each operation's (`['operations', 2, 'depth', 'depth']`).
 */
export function camSetupExpressions(setup: CamSetup): CamExpressionSite[] {
  return [
    ...camSetupOwnExpressions(setup),
    ...setup.operations.flatMap((op, i) =>
      camExpressions(op).map((site) => ({ ...site, path: ['operations', i, ...site.path] })),
    ),
  ];
}

/** The face references an operation holds, in geometry order. */
export function camOperationReferences(op: CamOperation): FaceReference[] {
  const out: FaceReference[] = [];
  for (const source of op.geometry) if (source.kind === 'face') out.push(source.face);
  return out;
}

/** Every id an operation owns: its own, then its face references' (`r<n>`). */
export function camOperationIds(op: CamOperation): string[] {
  return [op.id, ...camOperationReferences(op).map((r) => r.id)];
}

/** The ids a setup owns besides its operations': its own and its WCS face reference's. */
export function camSetupOwnIds(setup: CamSetup): string[] {
  return setup.wcs.up.kind === 'face' ? [setup.id, setup.wcs.up.face.id] : [setup.id];
}

/** Every id a setup owns: its own (`camSetupOwnIds`), then each operation's, in cut order. */
export function camSetupIds(setup: CamSetup): string[] {
  return [...camSetupOwnIds(setup), ...setup.operations.flatMap(camOperationIds)];
}

/** The tools an operation cuts with: its own, then a V-carve's clearing tool. */
export function camOperationTools(op: CamOperation): string[] {
  return op.kind === 'vcarve' && op.clearing ? [op.tool, op.clearing.tool] : [op.tool];
}

/** Operations, in any setup, that cut with tool `toolId`, as `<setup id>/<operation id>`. */
export function camToolUsers(cam: CamData, toolId: string): string[] {
  const out: string[] = [];
  for (const setup of cam.setups) {
    for (const op of setup.operations) {
      if (camOperationTools(op).includes(toolId)) out.push(`${setup.id}/${op.id}`);
    }
  }
  return out;
}
