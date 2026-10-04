import { applyConfigurationRow, configurationRow } from './configurations';
import {
  camSetupExpressions,
  camToolExpressions,
  drawingExpressions,
  explodedViewExpressions,
  featureExpressions,
  mateExpressions,
  printSetupExpressions,
} from './features';
import type {
  Assembly,
  CamData,
  Domains,
  Drawing,
  ManufaktureDocument,
  Part,
  PrintData,
  Script,
  StoredExpression,
  Variable,
} from './schema';
import { expressionVariableNames } from './validate';

/**
 * What changed between two documents, for subscribers: regen (T1.9) restarts from
 * `firstAffectedIndex`, and the UI refreshes what it shows. Computed by comparing documents, so
 * it is the same whether the change came from a command, an undo, a redo or a load.
 */
export interface DocumentChange {
  /** Nothing changed at all. */
  readonly empty: boolean;
  readonly nameChanged: boolean;
  /** Display units only: stored expressions keep their own units, so no geometry changes. */
  readonly unitsChanged: boolean;
  /**
   * The configuration table changed (parameters, rows or the active row). What that does to the
   * active configuration is reported in `variables` and `parts` as well.
   */
  readonly configurationsChanged: boolean;
  /**
   * Variables whose expression changed, in the document or in the configuration it is built in
   * (the active row): a change of the active row, or of its values, lists the variables it
   * overrides differently, as if they had been edited.
   */
  readonly variables: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  /**
   * Per part, as for `variables`: a feature whose suppression the active row changes is
   * `changed`, and `firstAffectedIndex` counts it and every feature reading a variable the row
   * changes.
   */
  readonly parts: readonly PartChange[];
  /**
   * Per assembly that changed. An assembly change never regenerates a part; what an instance
   * shows changes when its part does, which `parts` reports.
   */
  readonly assemblies: readonly AssemblyChange[];
  /**
   * The print section changed: a setup or item was added, removed or edited, or a threshold or
   * orientation reads a changed variable. Never a regen trigger: print setups change no
   * geometry, so a print edit adds nothing to `parts` and has no `firstAffectedIndex` (ADR 0012
   * decision 1). The print workspace re-checks the setups `print` lists.
   */
  readonly printChanged: boolean;
  readonly print: PrintChange;
  /**
   * The CAM section changed (since version 14): a tool, setup or operation was added, removed or
   * edited, setups were reordered, or an expression in a tool or setup reads a changed variable.
   * Never a regen trigger: CAM changes no geometry, so a CAM-only edit adds nothing to `parts`
   * and has no `firstAffectedIndex` (ADR 0014 decision 2). Which operations changed is the CAM
   * workspace's to find, by its toolpath keys (decision 9); `cam` says which tools and setups.
   */
  readonly camChanged: boolean;
  readonly cam: CamChange;
  /**
   * The font list changed (a font added or removed; since version 9). Never a regen trigger by
   * itself: a font's bytes never change under its id and a font in use cannot be removed, so
   * only an outline that starts or stops using a font changes geometry, and its sketch's part
   * reports that.
   */
  readonly fontsChanged: boolean;
  /**
   * The ids of library scripts added, removed or changed (source, language, API version or
   * name), sorted; empty when none did (since version 16). A script whose source, language or API
   * version changed also changes every scripted feature that runs it: `parts` lists those as
   * `changed`, with `firstAffectedIndex` at or before them, as if they had been edited.
   */
  readonly scriptsChanged: readonly string[];
  /**
   * The namespaces whose `domains` entry was added, removed or changed (its `schemaVersion` or
   * its `data`), sorted; empty when none did (since version 11). Never a regen trigger by itself,
   * so it adds nothing to `parts` and has no `firstAffectedIndex`: core cannot see inside domain
   * data, so the domain decides which of its features a change affects (ADR 0013 decision 5).
   */
  readonly domainChanged: readonly string[];
  /**
   * Anything in `drawings` changed: a drawing, sheet, view, dimension or note was added, removed,
   * edited or moved, or a sheet size, view scale or section offset reads a changed variable (since
   * version 12). Never a regen trigger: a drawing changes no geometry, so a drawing-only edit adds
   * nothing to `parts` or `assemblies` and has no `firstAffectedIndex`. The drawing workspace
   * asks regen for the views it shows again (T4.4e caches them by the bodies they show).
   */
  readonly drawingChanged: boolean;
  readonly drawings: DrawingsChange;
}

/**
 * Drawings that changed, by id. `changed` lists drawings with any change inside (name, sheets,
 * views, dimensions, notes) or whose expressions read a changed variable (also through other
 * variables, or through the active configuration row).
 */
export interface DrawingsChange {
  readonly drawings: ItemChanges;
  /** The relative order of drawings present in both documents changed. */
  readonly reordered: boolean;
}

/**
 * Print setups that changed, by id. `changed` lists setups whose name, printer, nozzle,
 * thresholds or items changed, or whose expressions read a changed variable (also through other
 * variables, or through the active configuration row).
 */
export interface PrintChange {
  readonly setups: ItemChanges;
  /** The relative order of setups present in both documents changed. */
  readonly reordered: boolean;
}

/**
 * CAM tools and setups that changed, by id. `setups.changed` lists setups with any change inside
 * (name, part, body, machine, post, stock, WCS, heights, operations) or whose expressions, their
 * operations' included, read a changed variable (also through other variables, or through the
 * active configuration row); `tools.changed` the same for tools. A tool edit lists the tool, not
 * the setups whose operations cut with it.
 */
export interface CamChange {
  readonly tools: ItemChanges;
  readonly setups: ItemChanges;
  /** The relative order of setups present in both documents changed. */
  readonly reordered: boolean;
}

/** Added, removed and changed items of one kind in an assembly, by id. */
export interface ItemChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface AssemblyChange {
  readonly assemblyId: string;
  /** Assemblies that exist in only one of the two documents. */
  readonly status: 'added' | 'removed' | 'changed';
  readonly nameChanged: boolean;
  /** Instances; `changed` lists those with any change but their pose. */
  readonly instances: ItemChanges;
  /** Instances whose pose changed. */
  readonly posed: readonly string[];
  /**
   * Mates; `changed` lists those edited, suppressed or renamed, and those whose connector
   * offsets or limits read a changed variable (also through other variables, or through the
   * active configuration row).
   */
  readonly mates: ItemChanges;
  /** The relative order of mates present in both documents changed (it decides blame). */
  readonly matesReordered: boolean;
  /**
   * Exploded views (since version 12); `changed` lists those renamed or whose steps changed, or
   * whose step distances read a changed variable. Exploded views never change solved poses.
   */
  readonly explodedViews: ItemChanges;
  /** The relative order of exploded views present in both documents changed. */
  readonly explodedViewsReordered: boolean;
  /**
   * Only instance poses changed (a committed drag or solve): nothing to regenerate and nothing to
   * solve again, since the poses are already the solver's answer.
   */
  readonly posesOnly: boolean;
  /**
   * Only exploded views changed: nothing to regenerate and nothing to solve; the exploded
   * offsets (T4.5a) are computed again from the same solved poses.
   */
  readonly explodedOnly: boolean;
}

export interface PartChange {
  readonly partId: string;
  /** Parts that exist in only one of the two documents. */
  readonly status: 'added' | 'removed' | 'changed';
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Features whose inputs, name or suppression changed. */
  readonly changed: readonly string[];
  /** The relative order of features present in both documents changed. */
  readonly reordered: boolean;
  readonly rollbackChanged: boolean;
  /** The part's material changed. No geometry changes; masses do. */
  readonly materialChanged: boolean;
  /**
   * A body's name, colour or material changed (`Part.bodies`). No geometry changes; what bodies
   * look like and weigh does.
   */
  readonly bodyPropsChanged: boolean;
  /**
   * The first index in the new feature list whose result may differ, because the feature or an
   * earlier one was added, removed, edited, moved, suppressed, or reads a changed variable (also
   * through other variables), or because the rollback bar moved past it. `null`: no feature
   * result changes (a rename, or nothing at all).
   */
  readonly firstAffectedIndex: number | null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

function diffVariables(prev: readonly Variable[], next: readonly Variable[]) {
  const p = new Map(prev.map((v) => [v.name, v]));
  const n = new Map(next.map((v) => [v.name, v]));
  return {
    added: next.filter((v) => !p.has(v.name)).map((v) => v.name),
    removed: prev.filter((v) => !n.has(v.name)).map((v) => v.name),
    changed: next
      .filter((v) => p.has(v.name) && !deepEqual(p.get(v.name)!.expression, v.expression))
      .map((v) => v.name),
  };
}

/** Changed variables plus every variable that reads one of them, directly or not. */
function affectedVariables(next: readonly Variable[], touched: Iterable<string>): Set<string> {
  const affected = new Set(touched);
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of next) {
      if (affected.has(v.name)) continue;
      if (expressionVariableNames(v.expression).some((d) => affected.has(d))) {
        affected.add(v.name);
        grew = true;
      }
    }
  }
  return affected;
}

function withoutName<T extends { name: string }>(f: T): Omit<T, 'name'> {
  const { name: _name, ...rest } = f;
  void _name;
  return rest;
}

function diffPart(
  prev: Part | undefined,
  next: Part | undefined,
  vars: ReadonlySet<string>,
  scripts: ReadonlySet<string> = new Set(),
): PartChange {
  const partId = (next ?? prev)!.id;
  const pf = prev?.features ?? [];
  const nf = next?.features ?? [];
  const pById = new Map(pf.map((f) => [f.id, f]));
  const nIds = new Set(nf.map((f) => f.id));
  const added = nf.filter((f) => !pById.has(f.id)).map((f) => f.id);
  const removed = pf.filter((f) => !nIds.has(f.id)).map((f) => f.id);
  const changed: string[] = [];
  let first: number | null = null;
  const mark = (i: number) => {
    if (first === null || i < first) first = i;
  };

  const pCommon = pf.filter((f) => nIds.has(f.id)).map((f) => f.id);
  const nCommon = nf.filter((f) => pById.has(f.id)).map((f) => f.id);
  const reordered = pCommon.some((id, i) => nCommon[i] !== id);

  let common = 0;
  nf.forEach((f, i) => {
    const old = pById.get(f.id);
    if (!old) {
      mark(i);
      return;
    }
    if (nCommon[common] !== pCommon[common]) mark(i);
    common++;
    if (!deepEqual(old, f)) {
      changed.push(f.id);
      if (!deepEqual(withoutName(old), withoutName(f))) mark(i);
    }
    if (
      vars.size > 0 &&
      featureExpressions(f).some((s) =>
        expressionVariableNames(s.expression).some((n) => vars.has(n)),
      )
    ) {
      mark(i);
    }
    // A scripted feature whose script was edited regenerates like an edited feature.
    if (f.kind === 'scripted' && scripts.has(f.script)) {
      if (!changed.includes(f.id)) changed.push(f.id);
      mark(i);
    }
  });
  // A removed feature affects whatever now sits where it was.
  pf.forEach((f, i) => {
    if (!nIds.has(f.id)) {
      const before = pf.slice(0, i).filter((x) => nIds.has(x.id)).length;
      mark(before);
    }
  });

  const prb = prev?.rollbackIndex ?? null;
  const nrb = next?.rollbackIndex ?? null;
  const rollbackChanged = prb !== nrb;
  if (rollbackChanged && prev && next) {
    // Features between the two bar positions switch between active and inactive.
    const p = prb ?? pf.length;
    const n = nrb ?? nf.length;
    mark(Math.min(p, n));
  }
  if (first !== null && first > nf.length) first = nf.length;
  const materialChanged = !!prev && !!next && prev.material !== next.material;
  const bodyPropsChanged = !!prev && !!next && !deepEqual(prev.bodies, next.bodies);

  return {
    partId,
    status: !prev ? 'added' : !next ? 'removed' : 'changed',
    added,
    removed,
    changed,
    reordered,
    rollbackChanged,
    materialChanged,
    bodyPropsChanged,
    firstAffectedIndex: first,
  };
}

function withoutPose<T extends { pose: unknown }>(i: T): Omit<T, 'pose'> {
  const { pose: _pose, ...rest } = i;
  void _pose;
  return rest;
}

function diffAssembly(
  prev: Assembly | undefined,
  next: Assembly | undefined,
  vars: ReadonlySet<string>,
): AssemblyChange {
  const assemblyId = (next ?? prev)!.id;
  const pi = new Map((prev?.instances ?? []).map((x) => [x.id, x]));
  const ni = next?.instances ?? [];
  const nIds = new Set(ni.map((x) => x.id));
  const instances: ItemChanges = {
    added: ni.filter((x) => !pi.has(x.id)).map((x) => x.id),
    removed: (prev?.instances ?? []).filter((x) => !nIds.has(x.id)).map((x) => x.id),
    changed: ni
      .filter((x) => pi.has(x.id) && !deepEqual(withoutPose(pi.get(x.id)!), withoutPose(x)))
      .map((x) => x.id),
  };
  const posed = ni
    .filter((x) => pi.has(x.id) && !deepEqual(pi.get(x.id)!.pose, x.pose))
    .map((x) => x.id);

  const pm = prev?.mates ?? [];
  const nm = next?.mates ?? [];
  const pById = new Map(pm.map((m) => [m.id, m]));
  const nmIds = new Set(nm.map((m) => m.id));
  const readsChanged = (m: (typeof nm)[number]) =>
    vars.size > 0 &&
    mateExpressions(m).some((s) => expressionVariableNames(s.expression).some((n) => vars.has(n)));
  const mates: ItemChanges = {
    added: nm.filter((m) => !pById.has(m.id)).map((m) => m.id),
    removed: pm.filter((m) => !nmIds.has(m.id)).map((m) => m.id),
    changed: nm
      .filter((m) => pById.has(m.id) && (!deepEqual(pById.get(m.id), m) || readsChanged(m)))
      .map((m) => m.id),
  };
  const pCommon = pm.filter((m) => nmIds.has(m.id)).map((m) => m.id);
  const nCommon = nm.filter((m) => pById.has(m.id)).map((m) => m.id);
  const matesReordered = pCommon.some((id, i) => nCommon[i] !== id);
  const exploded = diffItems(prev?.explodedViews ?? [], next?.explodedViews ?? [], (v) =>
    readsAny(explodedViewExpressions(v), vars),
  );
  const nameChanged = !!prev && !!next && prev.name !== next.name;
  const status = !prev ? 'added' : !next ? 'removed' : 'changed';
  const untouched = (c: ItemChanges) => c.added.length + c.removed.length + c.changed.length === 0;
  const explodedTouched = !untouched(exploded.items) || exploded.reordered;
  const posesOnly =
    status === 'changed' &&
    posed.length > 0 &&
    !nameChanged &&
    !matesReordered &&
    !explodedTouched &&
    [instances, mates].every(untouched);
  const explodedOnly =
    status === 'changed' &&
    explodedTouched &&
    posed.length === 0 &&
    !nameChanged &&
    !matesReordered &&
    [instances, mates].every(untouched);
  return {
    assemblyId,
    status,
    nameChanged,
    instances,
    posed,
    mates,
    matesReordered,
    explodedViews: exploded.items,
    explodedViewsReordered: exploded.reordered,
    posesOnly,
    explodedOnly,
  };
}

/** Whether any of the expressions reads one of `vars`. */
function readsAny(
  sites: readonly { expression: StoredExpression }[],
  vars: ReadonlySet<string>,
): boolean {
  return (
    vars.size > 0 &&
    sites.some((s) => expressionVariableNames(s.expression).some((n) => vars.has(n)))
  );
}

/** Added, removed and changed items of a list with ids, and whether the common ones moved. */
function diffItems<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
  readsChanged: (item: T) => boolean,
): { items: ItemChanges; reordered: boolean } {
  const p = new Map(prev.map((x) => [x.id, x]));
  const nIds = new Set(next.map((x) => x.id));
  const pCommon = prev.filter((x) => nIds.has(x.id)).map((x) => x.id);
  const nCommon = next.filter((x) => p.has(x.id)).map((x) => x.id);
  return {
    items: {
      added: next.filter((x) => !p.has(x.id)).map((x) => x.id),
      removed: prev.filter((x) => !nIds.has(x.id)).map((x) => x.id),
      changed: next
        .filter((x) => p.has(x.id) && (!deepEqual(p.get(x.id), x) || readsChanged(x)))
        .map((x) => x.id),
    },
    reordered: pCommon.some((id, i) => nCommon[i] !== id),
  };
}

function diffDrawings(
  prev: readonly Drawing[] | undefined,
  next: readonly Drawing[] | undefined,
  vars: ReadonlySet<string>,
): DrawingsChange {
  const d = diffItems(prev ?? [], next ?? [], (x) => readsAny(drawingExpressions(x), vars));
  return { drawings: d.items, reordered: d.reordered };
}

function diffAssemblies(
  prev: ManufaktureDocument,
  next: ManufaktureDocument,
  vars: ReadonlySet<string>,
): AssemblyChange[] {
  const pa = new Map(prev.assemblies.map((a) => [a.id, a]));
  const na = new Set(next.assemblies.map((a) => a.id));
  const out: AssemblyChange[] = [];
  for (const a of next.assemblies) {
    const old = pa.get(a.id);
    if (old === a && vars.size === 0) continue;
    const c = diffAssembly(old, a, vars);
    const noop =
      c.status === 'changed' &&
      !c.nameChanged &&
      !c.matesReordered &&
      c.posed.length === 0 &&
      !c.explodedViewsReordered &&
      [c.instances, c.mates, c.explodedViews].every(
        (x) => x.added.length + x.removed.length + x.changed.length === 0,
      ) &&
      deepEqual(old, a);
    if (!noop) out.push(c);
  }
  for (const a of prev.assemblies) if (!na.has(a.id)) out.push(diffAssembly(a, undefined, vars));
  return out;
}

function diffPrint(prev: PrintData, next: PrintData, vars: ReadonlySet<string>): PrintChange {
  const ps = new Map(prev.setups.map((x) => [x.id, x]));
  const nIds = new Set(next.setups.map((x) => x.id));
  const readsChanged = (setup: PrintData['setups'][number]) =>
    vars.size > 0 &&
    printSetupExpressions(setup).some((s) =>
      expressionVariableNames(s.expression).some((n) => vars.has(n)),
    );
  const pCommon = prev.setups.filter((x) => nIds.has(x.id)).map((x) => x.id);
  const nCommon = next.setups.filter((x) => ps.has(x.id)).map((x) => x.id);
  return {
    setups: {
      added: next.setups.filter((x) => !ps.has(x.id)).map((x) => x.id),
      removed: prev.setups.filter((x) => !nIds.has(x.id)).map((x) => x.id),
      changed: next.setups
        .filter((x) => ps.has(x.id) && (!deepEqual(ps.get(x.id), x) || readsChanged(x)))
        .map((x) => x.id),
    },
    reordered: pCommon.some((id, i) => nCommon[i] !== id),
  };
}

/** Added, removed and changed items of a list by id, and whether the common ones moved. */
function diffList<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
  readsChanged: (item: T) => boolean,
): { items: ItemChanges; reordered: boolean } {
  const p = new Map(prev.map((x) => [x.id, x]));
  const nIds = new Set(next.map((x) => x.id));
  const pCommon = prev.filter((x) => nIds.has(x.id)).map((x) => x.id);
  const nCommon = next.filter((x) => p.has(x.id)).map((x) => x.id);
  return {
    items: {
      added: next.filter((x) => !p.has(x.id)).map((x) => x.id),
      removed: prev.filter((x) => !nIds.has(x.id)).map((x) => x.id),
      changed: next
        .filter((x) => p.has(x.id) && (!deepEqual(p.get(x.id), x) || readsChanged(x)))
        .map((x) => x.id),
    },
    reordered: pCommon.some((id, i) => nCommon[i] !== id),
  };
}

function diffCam(prev: CamData, next: CamData, vars: ReadonlySet<string>): CamChange {
  const reads = (sites: readonly { expression: StoredExpression }[]) =>
    vars.size > 0 &&
    sites.some((s) => expressionVariableNames(s.expression).some((n) => vars.has(n)));
  const tools = diffList(prev.tools, next.tools, (t) => reads(camToolExpressions(t)));
  const setups = diffList(prev.setups, next.setups, (s) => reads(camSetupExpressions(s)));
  return { tools: tools.items, setups: setups.items, reordered: setups.reordered };
}

function touched(items: ItemChanges): boolean {
  return items.added.length + items.removed.length + items.changed.length > 0;
}

function printTouched(change: PrintChange): boolean {
  const { added, removed, changed } = change.setups;
  return change.reordered || added.length + removed.length + changed.length > 0;
}

function diffRaw(prev: ManufaktureDocument, next: ManufaktureDocument): DocumentChange {
  const variables = diffVariables(prev.variables, next.variables);
  const vars = affectedVariables(next.variables, [
    ...variables.added,
    ...variables.removed,
    ...variables.changed,
  ]);
  const pParts = new Map(prev.parts.map((p) => [p.id, p]));
  const nParts = new Map(next.parts.map((p) => [p.id, p]));
  const scriptsChanged = diffScripts(prev.scripts, next.scripts, false);
  // A script's name is for display: renaming it changes no geometry.
  const scripts = new Set(diffScripts(prev.scripts, next.scripts, true));
  const parts: PartChange[] = [];
  for (const p of next.parts) {
    const old = pParts.get(p.id);
    // An untouched part still changes when its features read a changed variable or script.
    if (old === p && vars.size === 0 && scripts.size === 0) continue;
    const c = diffPart(old, p, vars, scripts);
    const noop =
      c.status === 'changed' &&
      c.added.length + c.removed.length + c.changed.length === 0 &&
      !c.reordered &&
      !c.rollbackChanged &&
      !c.materialChanged &&
      !c.bodyPropsChanged &&
      c.firstAffectedIndex === null &&
      deepEqual(old, p);
    if (!noop) parts.push(c);
  }
  for (const p of prev.parts) if (!nParts.has(p.id)) parts.push(diffPart(p, undefined, vars));
  const assemblies = diffAssemblies(prev, next, vars);
  const print = diffPrint(prev.print, next.print, vars);
  const cam = diffCam(prev.cam, next.cam, vars);
  const drawings = diffDrawings(prev.drawings, next.drawings, vars);
  const { added, removed, changed } = drawings.drawings;
  const nameChanged = prev.name !== next.name;
  const unitsChanged = !deepEqual(prev.units, next.units);
  const empty =
    !nameChanged &&
    !unitsChanged &&
    variables.added.length + variables.removed.length + variables.changed.length === 0 &&
    parts.length === 0 &&
    deepEqual(prev, next);
  return {
    empty,
    nameChanged,
    unitsChanged,
    configurationsChanged: !deepEqual(prev.configurations, next.configurations),
    variables,
    parts,
    assemblies,
    // The counters alone can differ (a restore keeps the higher ones): still a print change.
    printChanged: printTouched(print) || !deepEqual(prev.print, next.print),
    print,
    // As for print: the counters alone can differ after a restore.
    camChanged:
      cam.reordered || touched(cam.tools) || touched(cam.setups) || !deepEqual(prev.cam, next.cam),
    cam,
    fontsChanged: !deepEqual(prev.fonts, next.fonts),
    scriptsChanged,
    domainChanged: diffDomains(prev.domains, next.domains),
    drawingChanged:
      drawings.reordered ||
      added.length + removed.length + changed.length > 0 ||
      !deepEqual(prev.drawings, next.drawings),
    drawings,
  };
}

/**
 * The ids of scripts added, removed or changed between two documents, sorted; with `ignoreName`,
 * a script whose name alone changed does not count.
 */
function diffScripts(
  prev: readonly Script[] | undefined,
  next: readonly Script[] | undefined,
  ignoreName: boolean,
): string[] {
  if (prev === next) return [];
  const strip = (s: Script | undefined) => (s && ignoreName ? { ...s, name: '' } : s);
  const p = new Map((prev ?? []).map((s) => [s.id, s]));
  const n = new Map((next ?? []).map((s) => [s.id, s]));
  const ids = new Set([...p.keys(), ...n.keys()]);
  return [...ids].filter((id) => !deepEqual(strip(p.get(id)), strip(n.get(id)))).sort();
}

/** The namespaces whose domain data differs between two documents, sorted. */
function diffDomains(prev: Domains | undefined, next: Domains | undefined): string[] {
  if (prev === next) return [];
  const p = prev ?? {};
  const n = next ?? {};
  const namespaces = new Set([...Object.keys(p), ...Object.keys(n)]);
  return [...namespaces]
    .filter((ns) => {
      const a = Object.hasOwn(p, ns) ? p[ns] : undefined;
      const b = Object.hasOwn(n, ns) ? n[ns] : undefined;
      return !deepEqual(a, b);
    })
    .sort();
}

/** The document with its active configuration row applied (what T2.4b has regen build). */
function effective(doc: ManufaktureDocument): ManufaktureDocument {
  const row = configurationRow(doc);
  return row ? applyConfigurationRow(doc, row) : doc;
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function minIndex(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

function mergeItems(a: ItemChanges, b: ItemChanges): ItemChanges {
  return {
    added: union(a.added, b.added),
    removed: union(a.removed, b.removed),
    changed: union(a.changed, b.changed),
  };
}

function mergeAssembly(a: AssemblyChange, b: AssemblyChange): AssemblyChange {
  return {
    assemblyId: a.assemblyId,
    status: a.status,
    nameChanged: a.nameChanged || b.nameChanged,
    instances: mergeItems(a.instances, b.instances),
    posed: union(a.posed, b.posed),
    mates: mergeItems(a.mates, b.mates),
    matesReordered: a.matesReordered || b.matesReordered,
    explodedViews: mergeItems(a.explodedViews, b.explodedViews),
    explodedViewsReordered: a.explodedViewsReordered || b.explodedViewsReordered,
    posesOnly: a.posesOnly && b.posesOnly,
    explodedOnly: a.explodedOnly && b.explodedOnly,
  };
}

function mergePart(a: PartChange, b: PartChange): PartChange {
  return {
    partId: a.partId,
    status: a.status,
    added: union(a.added, b.added),
    removed: union(a.removed, b.removed),
    changed: union(a.changed, b.changed),
    reordered: a.reordered || b.reordered,
    rollbackChanged: a.rollbackChanged || b.rollbackChanged,
    materialChanged: a.materialChanged || b.materialChanged,
    bodyPropsChanged: a.bodyPropsChanged || b.bodyPropsChanged,
    firstAffectedIndex: minIndex(a.firstAffectedIndex, b.firstAffectedIndex),
  };
}

/**
 * What changed between two documents. Changes are reported both for the documents as stored
 * and for them with their active configuration rows applied, merged: a subscriber that builds
 * the stored document and one that builds the configured one both see everything that affects
 * them. Switching the active row, or editing its values, reports the variables and features
 * the row overrides differently, so regen's dirty set is as for a variable edit.
 */
export function diffDocuments(
  prev: ManufaktureDocument,
  next: ManufaktureDocument,
): DocumentChange {
  const raw = diffRaw(prev, next);
  const ep = effective(prev);
  const en = effective(next);
  if (ep === prev && en === next) return raw;
  const configured = diffRaw(ep, en);
  const byId = new Map(configured.parts.map((p) => [p.partId, p]));
  const parts = raw.parts.map((p) => {
    const c = byId.get(p.partId);
    byId.delete(p.partId);
    return c ? mergePart(p, c) : p;
  });
  parts.push(...byId.values());
  const assemblyById = new Map(configured.assemblies.map((a) => [a.assemblyId, a]));
  const assemblies = raw.assemblies.map((a) => {
    const c = assemblyById.get(a.assemblyId);
    assemblyById.delete(a.assemblyId);
    return c ? mergeAssembly(a, c) : a;
  });
  assemblies.push(...assemblyById.values());
  return {
    ...raw,
    variables: {
      added: raw.variables.added,
      removed: raw.variables.removed,
      changed: union(raw.variables.changed, configured.variables.changed),
    },
    parts,
    assemblies,
    printChanged: raw.printChanged || configured.printChanged,
    print: {
      setups: mergeItems(raw.print.setups, configured.print.setups),
      reordered: raw.print.reordered || configured.print.reordered,
    },
    camChanged: raw.camChanged || configured.camChanged,
    cam: {
      tools: mergeItems(raw.cam.tools, configured.cam.tools),
      setups: mergeItems(raw.cam.setups, configured.cam.setups),
      reordered: raw.cam.reordered || configured.cam.reordered,
    },
    drawingChanged: raw.drawingChanged || configured.drawingChanged,
    drawings: {
      drawings: mergeItems(raw.drawings.drawings, configured.drawings.drawings),
      reordered: raw.drawings.reordered || configured.drawings.reordered,
    },
  };
}
