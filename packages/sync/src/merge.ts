// Field-level merge of an edit replayed onto a state that changed the same object (task #1216).
//
// A branch's `editFeature` (or `restoreFeature` over a feature that is there) and `setDomainData`
// carry the whole object. Replayed onto another branch that changed the same object since, the
// whole object would win and that branch's edits of other fields would be lost. With the field
// merge, the replayed command is rewritten before it applies: a three-way merge of the object as
// the branch saw it (the origin), as it is where the command lands (theirs), and as the branch
// wrote it (ours). A field only one side changed keeps that side's value; a field both changed to
// different values takes the branch's (the later writer). Fields are:
//
// - for a feature: its top-level fields; an extension feature's `params` and `expressions` by
//   key; and lists of objects with unique string ids (a wall's `overrides`) by element id, among
//   its top-level fields and its params. Anything else is one field (a param that is an object is
//   one value: two sides' halves of a point are never mixed).
// - for a domain's data (with the same `schemaVersion` on all three): objects by key and lists of
//   objects with ids by element id, at any depth.
//
// In a list merged by id, elements added on either side are kept; an element one side deleted and
// the other left alone is deleted; one side's edit against the other's delete goes to the branch
// (an edit brings the element back, a delete deletes it). The branch's order is kept unless only
// the other side reordered.
//
// Core never looks inside domain data or extension params, so a merged value could be one its
// domain cannot read (two framing layers in a wall type where each side kept one, more layers
// than allowed, overrides the wall reader refuses). Those are merged only with a `MergeValidator`
// that reads them as the domain does, and a merged value it refuses is not used: the branch's
// whole value is, and the merge says why (`whole`). Without a reader for the namespace or type,
// they are not merged by field at all.
//
// What the merge cost the other side is not reported here: `lostFields` compares the result with
// the other side's state afterwards, which also covers commands merged whole (any other command,
// and a merged command that does not validate, which the client applies unmerged instead).

import {
  applyCommand,
  type Command,
  type ManufaktureDocument,
  type SimpleCommand,
} from '@manufakture/core';

/** One step of a field path: a key of an object, or the id of an element of a list. */
export type PathStep = string | { readonly id: string };
export type FieldPath = readonly PathStep[];

/** Whether the merge looks inside a value at `path`: an object by key, a list by element id. */
export type MergePolicy = (path: FieldPath, kind: 'object' | 'list') => boolean;

/** Features: top-level fields, params and expressions by key, id lists by id one level down. */
export const featurePolicy: MergePolicy = (path, kind) => {
  if (kind === 'object') {
    return path.length === 0 || (path.length === 1 && isParamsOrExpressions(path[0]!));
  }
  return path.length === 1 || (path.length === 2 && path[0] === 'params');
};

/** Domain data: objects by key and id lists by id, at any depth. */
export const domainPolicy: MergePolicy = () => true;

/** Every other object (a variable, a part's settings, ...): only its top-level fields. */
export const shallowPolicy: MergePolicy = (path, kind) => kind === 'object' && path.length === 0;

function isParamsOrExpressions(step: PathStep): boolean {
  return step === 'params' || step === 'expressions';
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A list of objects that each have a string `id`, all different. The empty list is one. */
function isIdList(v: unknown): v is Plain[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const x of v) {
    if (!isPlain(x) || typeof x.id !== 'string' || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

/** Deep equality of JSON values; key order does not matter, list order does. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (isPlain(a)) {
    if (!isPlain(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

function byId(list: readonly Plain[]): Map<string, Plain> {
  return new Map(list.map((x) => [x.id as string, x]));
}

/** Whether `list`'s ids that are also in `of` come in `of`'s order. */
function keepsOrder(list: readonly string[], of: readonly string[]): boolean {
  const pos = new Map(of.map((id, i) => [id, i]));
  let last = -1;
  for (const id of list) {
    const p = pos.get(id);
    if (p === undefined) continue;
    if (p < last) return false;
    last = p;
  }
  return true;
}

/**
 * The three-way merge of `ours` (the branch's value, the later writer) and `theirs` (the value
 * where it lands), both from `origin`. `undefined` is an absent value (a key not there).
 */
export function mergeValues(
  origin: unknown,
  theirs: unknown,
  ours: unknown,
  policy: MergePolicy,
  path: FieldPath = [],
): unknown {
  if (sameValue(ours, origin)) return theirs;
  if (sameValue(theirs, origin) || sameValue(theirs, ours)) return ours;
  if (isPlain(origin) && isPlain(theirs) && isPlain(ours) && policy(path, 'object')) {
    const out: Plain = {};
    const keys = [...Object.keys(ours), ...Object.keys(theirs).filter((k) => !(k in ours))];
    for (const k of new Set([...keys, ...Object.keys(origin)])) {
      const v = mergeValues(origin[k], theirs[k], ours[k], policy, [...path, k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isIdList(origin) && isIdList(theirs) && isIdList(ours) && policy(path, 'list')) {
    return mergeLists(origin, theirs, ours, policy, path);
  }
  return ours;
}

function mergeLists(
  origin: readonly Plain[],
  theirs: readonly Plain[],
  ours: readonly Plain[],
  policy: MergePolicy,
  path: FieldPath,
): Plain[] {
  const o = byId(origin);
  const t = byId(theirs);
  const b = byId(ours);
  const oIds = origin.map((x) => x.id as string);
  const tIds = theirs.map((x) => x.id as string);
  const bIds = ours.map((x) => x.id as string);
  // Each id's merged element, or undefined when it is gone.
  const merged = new Map<string, Plain | undefined>();
  for (const id of new Set([...oIds, ...tIds, ...bIds])) {
    const v = mergeValues(o.get(id), t.get(id), b.get(id), policy, [...path, { id }]);
    merged.set(id, v as Plain | undefined);
  }
  // The order: ours, unless only theirs reordered what was there.
  const [main, other] =
    keepsOrder(bIds, oIds) && !keepsOrder(tIds, oIds) ? [tIds, bIds] : [bIds, tIds];
  const order = main.filter((id) => merged.get(id) !== undefined);
  // What only the other side has: after the element before it there, or first.
  for (const [i, id] of other.entries()) {
    if (order.includes(id) || merged.get(id) === undefined) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(other[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    order.splice(at, 0, id);
  }
  // An element that only the origin had and both kept somehow (cannot happen): last.
  for (const id of oIds) if (!order.includes(id) && merged.get(id) !== undefined) order.push(id);
  return order.map((id) => merged.get(id)!);
}

/**
 * The fields of an object where `theirs` (one side's state, changed from `origin`) is not in
 * `merged`: what a merge overwrote of that side's work. An empty path is the whole object (it is
 * gone, or no finer field can be named); a path ending in `ORDER` is a list whose reorder was
 * lost.
 */
export function lostFields(
  origin: unknown,
  theirs: unknown,
  merged: unknown,
  policy: MergePolicy,
  path: FieldPath = [],
  out: FieldPath[] = [],
): FieldPath[] {
  if (sameValue(theirs, origin) || sameValue(merged, theirs)) return out;
  if (isPlain(theirs) && isPlain(merged) && policy(path, 'object')) {
    const o = isPlain(origin) ? origin : {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(theirs)])) {
      lostFields(o[k], theirs[k], merged[k], policy, [...path, k], out);
    }
    return out;
  }
  if (isIdList(theirs) && isIdList(merged) && policy(path, 'list')) {
    const o = isIdList(origin) ? origin : [];
    const ob = byId(o);
    const tb = byId(theirs);
    const mb = byId(merged);
    for (const id of new Set([...ob.keys(), ...tb.keys()])) {
      lostFields(ob.get(id), tb.get(id), mb.get(id), policy, [...path, { id }], out);
    }
    const tIds = theirs.map((x) => x.id as string);
    const oIds = o.map((x) => x.id as string);
    if (
      !keepsOrder(tIds, oIds) &&
      !keepsOrder(
        merged.map((x) => x.id as string),
        tIds,
      )
    ) {
      out.push([...path, ORDER]);
    }
    return out;
  }
  out.push(path);
  return out;
}

/** The last step of a path whose list order was lost (`lostFields`). */
export const ORDER = '\u0000order';

/** A field path as the user reads it: `params.overrides[s3]`, `construction.headerRules`. */
export function formatPath(path: FieldPath): string {
  let out = '';
  for (const step of path) {
    if (step === ORDER) out += out === '' ? 'the order' : ' (order)';
    else if (typeof step === 'string') out += out === '' ? step : `.${step}`;
    else out += `[${step.id}]`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Commands

/**
 * What a command saw of each object it replaces whole, one entry per simple command in order
 * (a batch's flattened): the inverse that puts the object back as it was (`restoreFeature` or
 * `setDomainData`), or null where there is nothing to merge by field.
 */
export type Origins = readonly (Command | null)[];

type Leaf = SimpleCommand;

function leaves(command: Command): Leaf[] {
  return command.type === 'batch' ? command.commands.flatMap(leaves) : [command];
}

/** The inverses of `command`'s leaves, in the leaves' order (a batch's inverse is reversed). */
function leafInverses(command: Command, inverse: Command): (Command | undefined)[] {
  if (command.type !== 'batch') return [inverse];
  if (inverse.type !== 'batch' || inverse.commands.length !== command.commands.length) {
    return leaves(command).map(() => undefined);
  }
  const n = command.commands.length;
  return command.commands.flatMap((c, i) => leafInverses(c, inverse.commands[n - 1 - i]!));
}

/** The key of the object a leaf replaces whole, and the value it writes. */
function target(leaf: Leaf): { key: string; value: unknown } | undefined {
  switch (leaf.type) {
    case 'editFeature':
    case 'restoreFeature':
      return { key: `f\u0000${leaf.partId}\u0000${leaf.feature.id}`, value: leaf.feature };
    case 'setDomainData':
      return { key: `d\u0000${leaf.namespace}`, value: domainEntry(leaf) };
    default:
      return undefined;
  }
}

function domainEntry(c: Extract<Leaf, { type: 'setDomainData' }>): unknown {
  return c.schemaVersion === undefined || !('data' in c)
    ? undefined
    : { schemaVersion: c.schemaVersion, data: c.data };
}

/** The object `key` (from `target`) in `doc`, or undefined when it is not there. */
function valueIn(doc: ManufaktureDocument, key: string): unknown {
  const [kind, a = '', b = ''] = key.split('\u0000');
  if (kind === 'f') return doc.parts.find((p) => p.id === a)?.features.find((f) => f.id === b);
  return Object.hasOwn(doc.domains ?? {}, a) ? doc.domains![a] : undefined;
}

/** The value an origin (an inverse) puts back, for the object of `leaf`; undefined: none. */
function originValue(leaf: Leaf, origin: Command): { value: unknown } | undefined {
  if (leaf.type === 'setDomainData') {
    return origin.type === 'setDomainData' && origin.namespace === leaf.namespace
      ? { value: domainEntry(origin) }
      : undefined;
  }
  if (leaf.type === 'editFeature' || leaf.type === 'restoreFeature') {
    return (origin.type === 'restoreFeature' || origin.type === 'editFeature') &&
      origin.partId === leaf.partId &&
      origin.feature.id === leaf.feature.id
      ? { value: origin.feature }
      : undefined;
  }
  return undefined;
}

/**
 * `command`'s origins on `made`, the state it was made on (see `Origins`). A leaf whose object a
 * command before it in the same batch changed by other means gets none: the merge could not
 * tell that change from the other side's.
 */
export function commandOrigins(made: ManufaktureDocument, command: Command): Origins {
  const applied = applyCommand(made, command);
  const list = leaves(command);
  if (!applied.ok) return list.map(() => null);
  const inverses = leafInverses(command, applied.value.inverse);
  const tracked = new Map<string, unknown>();
  return list.map((leaf, i) => {
    const t = target(leaf);
    const inverse = inverses[i];
    if (t === undefined || inverse === undefined) return null;
    const origin = originValue(leaf, inverse);
    const expected = tracked.has(t.key) ? tracked.get(t.key) : valueIn(made, t.key);
    tracked.set(t.key, t.value);
    if (origin === undefined || origin.value === undefined) return null;
    return sameValue(origin.value, expected) ? inverse : null;
  });
}

/** A domain's verdict on a merged value: readable, or why not. */
export type MergeCheck = { ok: true } | { ok: false; message: string };

/**
 * What reads domain data and extension params, so a merged value is checked as the domain would
 * read it (core never looks inside them). Undefined: nothing here reads that namespace or type,
 * and the value is then not merged by field at all.
 */
export interface MergeValidator {
  domainData(namespace: string, data: unknown, schemaVersion: number): MergeCheck | undefined;
  extensionParams(type: string, params: unknown, schemaVersion: number): MergeCheck | undefined;
}

/** What `domainsValidator` needs of a domain: regen's `ExtensionDomain`, structurally. */
export interface ReadableDomain {
  readonly data?: Readonly<
    Record<string, { read(data: never, schemaVersion: number): { ok: boolean; message?: string } }>
  >;
  readonly types?: Readonly<
    Record<
      string,
      { params?(params: never, schemaVersion: number): { ok: boolean; message?: string } }
    >
  >;
}

/** A `MergeValidator` from domain definitions (regen's `ExtensionDomain`s: wood, construction...). */
export function domainsValidator(domains: readonly ReadableDomain[]): MergeValidator {
  const verdict = (r: { ok: boolean; message?: string }): MergeCheck =>
    r.ok ? { ok: true } : { ok: false, message: r.message ?? 'not readable' };
  const find = <T>(pick: (d: ReadableDomain) => T | undefined): T | undefined => {
    for (const d of domains) {
      const found = pick(d);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return {
    domainData(namespace, data, schemaVersion) {
      const reader = find((d) =>
        d.data && Object.hasOwn(d.data, namespace) ? d.data[namespace] : undefined,
      );
      return reader === undefined ? undefined : verdict(reader.read(data as never, schemaVersion));
    },
    extensionParams(type, params, schemaVersion) {
      const t = find((d) => (d.types && Object.hasOwn(d.types, type) ? d.types[type] : undefined));
      if (t === undefined) return undefined;
      return t.params === undefined
        ? { ok: true }
        : verdict(t.params(params as never, schemaVersion));
    },
  };
}

/**
 * One leaf merged by field onto `theirs` (the object where it lands), or the leaf as it is. A
 * merged value no domain here can read, or one its domain refuses, is not used: `whole` says why.
 */
function mergeLeaf(
  leaf: Leaf,
  origin: Command,
  theirs: unknown,
  validate: MergeValidator | undefined,
): { leaf: Leaf; whole?: string } {
  const o = originValue(leaf, origin)?.value;
  if (o === undefined || theirs === undefined) return { leaf };
  const refused = (what: string, check: MergeCheck | undefined): string | undefined => {
    if (check === undefined) return `nothing here reads ${what}, so it is not merged by field`;
    return check.ok ? undefined : `${what} merged by field does not read (${check.message})`;
  };
  if (leaf.type === 'setDomainData') {
    const b = domainEntry(leaf) as { schemaVersion: number; data: unknown } | undefined;
    const oe = o as { schemaVersion: number; data: unknown };
    const te = theirs as { schemaVersion: number; data: unknown };
    if (b === undefined || b.schemaVersion !== oe.schemaVersion) return { leaf };
    if (te.schemaVersion !== b.schemaVersion) return { leaf };
    const data = mergeValues(oe.data, te.data, b.data, domainPolicy) as NonNullable<
      typeof leaf.data
    >;
    if (sameValue(data, b.data)) return { leaf };
    const what = `the domain data "${leaf.namespace}"`;
    const whole = refused(what, validate?.domainData(leaf.namespace, data, b.schemaVersion));
    return whole === undefined ? { leaf: { ...leaf, data } } : { leaf, whole };
  }
  if (leaf.type === 'editFeature' || leaf.type === 'restoreFeature') {
    const of = o as { kind: string };
    const tf = theirs as { kind: string };
    if (of.kind !== leaf.feature.kind || tf.kind !== leaf.feature.kind) return { leaf };
    const feature = mergeValues(o, theirs, leaf.feature, featurePolicy) as typeof leaf.feature;
    if (sameValue(feature, leaf.feature)) return { leaf };
    // The branch's own params were read when it made them; merged ones are read again.
    if (
      feature.kind === 'extension' &&
      leaf.feature.kind === 'extension' &&
      !sameValue(feature.params, leaf.feature.params)
    ) {
      const what = `the params of ${feature.id} (${feature.extension})`;
      const check = validate?.extensionParams(
        feature.extension,
        feature.params,
        feature.schemaVersion,
      );
      const whole = refused(what, check);
      if (whole !== undefined) return { leaf, whole };
    }
    return { leaf: { ...leaf, feature } };
  }
  return { leaf };
}

/**
 * `command` (made with `origins`, from `commandOrigins`) merged by field onto `onto`: each leaf
 * that replaces a feature or a domain's data keeps what `onto` changed of it in fields the command
 * did not change. Domain data and extension params are merged only where `validate` reads them,
 * and kept only when it accepts the merged value; `whole` says, for each leaf left whole, why.
 * The result may still not apply (a merged feature core refuses); the caller then applies
 * `command` itself.
 */
export function mergeCommandFields(
  command: Command,
  origins: Origins,
  onto: ManufaktureDocument,
  validate?: MergeValidator,
): { command: Command; whole: string[] } {
  const list = leaves(command);
  if (origins.length !== list.length || origins.every((o) => o === null)) {
    return { command, whole: [] };
  }
  const tracked = new Map<string, unknown>();
  const whole: string[] = [];
  const merged = list.map((leaf, i) => {
    const t = target(leaf);
    if (t === undefined) return leaf;
    const origin = origins[i] ?? null;
    const theirs = tracked.has(t.key) ? tracked.get(t.key) : valueIn(onto, t.key);
    const out = origin === null ? { leaf } : mergeLeaf(leaf, origin, theirs, validate);
    if (out.whole !== undefined) whole.push(out.whole);
    tracked.set(t.key, target(out.leaf)!.value);
    return out.leaf;
  });
  let at = 0;
  const rebuild = (c: Command): Command =>
    c.type === 'batch' ? { ...c, commands: c.commands.map(rebuild) } : merged[at++]!;
  return { command: rebuild(command), whole };
}
