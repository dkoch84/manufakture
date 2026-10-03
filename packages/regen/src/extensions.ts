// Extension features: the translator registry (ADR 0013 decisions 4 and 5).
//
// A domain package (`packages/domain-wood`) registers, per extension type (`wood.board`), a
// translator: a pure, deterministic function from the feature (migrated and validated params,
// expressions evaluated with the kinds the domain declares, references resolved with their
// geometry, the domain data of the namespaces it may read, the results of the extensions of its
// namespace it names) to one or more kernel `FeatureInput`s carrying the feature's id, or an error
// value. A translator that needs geometry before it can say what to build (a joint asks for the
// faces of the boards it joins) has a first step, `queries`, which regen answers with existing
// kernel ops against the part as it stands before the feature.
//
// Regen imports no domain package: the app's worker entry registers the domains it ships, tests
// register fakes. Everything here is pure; the engine runs the kernel ops (`engine.ts`).
//
// Containment: every call into domain code goes through `guard`, so a throw becomes a feature
// error on that extension and never a failed regen. What a translator returns is checked before
// the kernel sees it (`checkOutput`); the kernel checks the inputs themselves (`applyFeature`
// reports a malformed input as that feature's error).

import {
  EXTENSION_TYPE_PATTERN,
  DOMAIN_NAMESPACE_PATTERN,
  type BooleanOperation,
  type DomainData,
  type Domains,
  type ExtensionFeature,
} from '@manufakture/core';
import type {
  EdgeRef,
  FeatureInput,
  OrientedBox,
  ReferenceReport,
  ResultMode,
  SketchProfile,
  TopoRef,
  Via,
} from '@manufakture/kernel';
import { stableStringify } from './hash';
import type { MemberStage } from './members';

// The member stage's types, for domains that import from this subpath (`members.ts`).
export type {
  MemberCut,
  MemberData,
  MemberFeature,
  MemberGroup,
  MemberGroupContext,
  MemberOutput,
  MemberPlacement,
  MemberPlane,
  MemberStage,
  MemberStageContext,
  MemberStock,
  MemberVec3,
  MemberWarning,
} from './members';
import type { SketchResult } from './sketches';
import type { FieldPath, RegenError } from './types';
import { evaluateField, type VariableValues } from './values';
import { evaluateQuantity } from '@manufakture/units';

/** Plain JSON, as core stores extension params and domain data. */
export type JsonValue = DomainData['data'];

/**
 * The kind a domain declares for a named expression (ADR 0013 decision 2). `slope` is an angle
 * read as a slope field (ADR 0005, amended by T6.0b): `6/12` and `6:12` are a roof pitch, `25%`
 * is `atan(0.25)`, and a bare number is an error; the value is in radians, as an angle's.
 */
export type ExpressionKind = 'length' | 'angle' | 'number' | 'slope';

/** A domain's answer to "can I read this": the value, or why not. Pure data. */
export type ReadResult<T> =
  { ok: true; value: T } | { ok: false; message: string; field?: FieldPath };

/** What a translator returns instead of inputs when the feature cannot be built. */
export interface ExtensionFailure {
  error: string;
  /** Where in the feature the problem is (`['params', 'stock']`, `['expressions', 'length']`). */
  field?: FieldPath;
  /** The reference at fault, so the app can offer a re-pick. */
  referenceId?: string;
}

/** What a translator builds: kernel inputs, each with the feature's id, applied in order. */
export interface ExtensionInputs {
  inputs: readonly FeatureInput[];
  /**
   * Derived data reported in the feature's result (`FeatureResult.metadata`) and given to later
   * extensions of the namespace that name this one (a board's frame). Recomputed on every
   * regen; never stored.
   */
  metadata?: JsonValue;
}

export type ExtensionOutput = ExtensionInputs | ExtensionFailure;

/** One reference of the feature, resolved on the body it lies on before the feature. */
export interface ResolvedReference {
  /** The body it lies on. */
  body: string;
  /** The name it resolved (the face, or the edge's faces joined). */
  target: string;
  via: Via;
  fragile: boolean;
  /** Planes, lines, circles; null when the kernel has no simple geometry for it. */
  geometry: Extract<ReferenceReport, { ok: true }>['geometry'];
}

/** A question the first step of a two-step translator asks about the part before the feature. */
export type GeometryQuery =
  /** A face or edge by name, on the body that carries it (the kernel's `resolve` op). */
  | { type: 'resolve'; ref: TopoRef }
  /** The oriented bounding box of a body (the kernel's `obb` op). */
  | { type: 'obb'; body: string };

/** The answer to a `GeometryQuery`, in the same position as the query. */
export type GeometryAnswer =
  | {
      type: 'resolve';
      /** The body the reference resolved on; null when no body carries it. */
      body: string | null;
      report: ReferenceReport;
    }
  | { type: 'obb'; body: string; box: OrientedBox | null; message?: string };

/** The result of an earlier extension of the same namespace that this one names in `dependsOn`. */
export interface ExtensionUpstream {
  type: string;
  inputs: readonly FeatureInput[];
  metadata?: JsonValue;
}

/** Everything a translator reads. Plain data plus one pure helper. */
export interface ExtensionContext<P = unknown> {
  /** The feature as stored (generic fields: id, operation, scope, references, dependsOn). */
  feature: ExtensionFeature;
  /** Params after the type's `params` (migrated to the current version and validated). */
  params: P;
  /** Evaluated expressions by name: mm, radians or plain numbers, by the declared kind. */
  values: Readonly<Record<string, number>>;
  /** The feature's references by id, resolved before the feature. */
  references: Readonly<Record<string, ResolvedReference>>;
  /**
   * The domain data of the namespaces the domain may read (its own and the shared ones it
   * declares), migrated and validated by the domain that owns each namespace. A namespace the
   * document has no entry for is absent.
   */
  data: Readonly<Record<string, unknown>>;
  /** Solved sketches the feature names in `dependsOn`, by id. */
  sketches: ReadonlyMap<string, SketchResult>;
  /** Results of extensions of the same namespace the feature names in `dependsOn`, by id. */
  upstream: ReadonlyMap<string, ExtensionUpstream>;
  /** The ids of the part's bodies before the feature, in creator order. */
  bodies: readonly string[];
  /** The kernel profile of a solved sketch in `sketches`: its regions, or those `entities` bound. */
  profile(sketchId: string, entities?: readonly string[]): ReadResult<SketchProfile>;
}

/**
 * One extension type. Methods, not function properties, so a domain's `ExtensionType<Board>`
 * registers where `ExtensionType` (of unknown params) is expected.
 */
export interface ExtensionType<P = unknown> {
  /** The newest `schemaVersion` of the type this build reads; a newer feature is `unsupported`. */
  schemaVersion: number;
  /** The kind of each named expression; an undeclared one is a plain number in internal units. */
  expressions?: Readonly<Record<string, ExpressionKind>>;
  /** Migrate params stored at `schemaVersion` to the current version and validate them. */
  params?(params: Readonly<Record<string, JsonValue>>, schemaVersion: number): ReadResult<P>;
  /** The two-step form's first step: what the translator needs to know about the part first. */
  queries?(context: ExtensionContext<P>): readonly GeometryQuery[] | ExtensionFailure;
  /** Build the kernel inputs; `answers` are the answers to `queries`, in order (else empty). */
  translate(context: ExtensionContext<P>, answers: readonly GeometryAnswer[]): ExtensionOutput;
}

/** Reads one namespace of domain data for the domain that owns it. */
export interface DomainDataReader {
  /** The newest `schemaVersion` of the data this build reads; a newer entry is `unsupported`. */
  schemaVersion: number;
  /** Migrate `data` stored at `schemaVersion` to the current version and validate it. Pure. */
  read(data: JsonValue, schemaVersion: number): ReadResult<unknown>;
}

/** A domain as it registers: its namespace, its extension types and the data it owns. */
export interface ExtensionDomain {
  /** `wood`: the first segment of every one of its types. */
  namespace: string;
  /**
   * Bump with any change that can alter a translator's output, so results built by older domain
   * code are never served from the cache (ADR 0004 decision 8).
   */
  implementation: number;
  /** Namespaces of domain data its translators read besides its own (shared ones: `stock`). */
  reads?: readonly string[];
  /** Readers for the namespaces it owns (its own, and in M4 `stock` too). */
  data?: Readonly<Record<string, DomainDataReader>>;
  /** Its extension types by full type (`wood.board`). */
  types?: Readonly<Record<string, ExtensionType>>;
  /**
   * Its member stage (ADR 0015 decision 5): framing members produced from the metadata of a
   * part's built extensions of this namespace, after the part's features (`members.ts`). Members
   * are data, never bodies; `implementation` keys their cache as it keys translator results.
   */
  members?: MemberStage;
}

interface DomainEntry {
  namespace: string;
  implementation: number;
  reads: readonly string[];
  data: Map<string, DomainDataReader>;
  types: Map<string, ExtensionType>;
  members: MemberStage | undefined;
}

/** A registered domain's member stage, with what keys and feeds it. */
export interface RegisteredMemberStage {
  namespace: string;
  implementation: number;
  /** Every namespace of domain data it is given, as for its domain's translators. */
  reads: readonly string[];
  stage: MemberStage;
}

/** A registered type with the domain it belongs to. */
export interface RegisteredExtension {
  type: string;
  definition: ExtensionType;
  namespace: string;
  implementation: number;
  /** Every namespace it may read: its domain's own first, then the shared ones, without duplicates. */
  reads: readonly string[];
}

/** The namespace of an extension type: its first segment. */
export function extensionNamespace(type: string): string {
  const dot = type.indexOf('.');
  return dot < 0 ? type : type.slice(0, dot);
}

/**
 * The domains a regen engine builds extensions with. Registration is checked (namespaces, type
 * patterns, versions, one owner per namespace and per type) and throws on a programming error.
 */
export class ExtensionRegistry {
  readonly #domains = new Map<string, DomainEntry>();

  /** Register a domain and its types. Returns a function that unregisters it. */
  registerDomain(domain: ExtensionDomain): () => void {
    const ns = domain.namespace;
    if (!DOMAIN_NAMESPACE_PATTERN.test(ns)) {
      throw new TypeError(`"${ns}" is not a domain namespace`);
    }
    if (this.#domains.has(ns)) throw new TypeError(`domain "${ns}" is already registered`);
    if (!Number.isSafeInteger(domain.implementation)) {
      throw new TypeError(`domain "${ns}": the implementation version must be an integer`);
    }
    for (const r of domain.reads ?? []) {
      if (!DOMAIN_NAMESPACE_PATTERN.test(r)) {
        throw new TypeError(`domain "${ns}" reads "${r}", which is not a namespace`);
      }
    }
    const data = new Map(Object.entries(domain.data ?? {}));
    for (const [owned, reader] of data) {
      if (!DOMAIN_NAMESPACE_PATTERN.test(owned)) {
        throw new TypeError(`domain "${ns}" owns "${owned}", which is not a namespace`);
      }
      const owner = this.#owner(owned);
      if (owner !== undefined) {
        throw new TypeError(`domain data "${owned}" is already owned by domain "${owner}"`);
      }
      checkVersion(reader.schemaVersion, `domain data "${owned}"`);
    }
    const entry: DomainEntry = {
      namespace: ns,
      implementation: domain.implementation,
      reads: [...new Set([ns, ...(domain.reads ?? [])])],
      data,
      types: new Map(),
      members: domain.members,
    };
    if (
      domain.members !== undefined &&
      (typeof domain.members.groups !== 'function' || typeof domain.members.frame !== 'function')
    ) {
      throw new TypeError(`domain "${ns}": a member stage needs groups and frame functions`);
    }
    for (const [type, definition] of Object.entries(domain.types ?? {})) {
      checkType(entry, type, definition);
      entry.types.set(type, definition);
    }
    this.#domains.set(ns, entry);
    return () => {
      if (this.#domains.get(ns) === entry) this.#domains.delete(ns);
    };
  }

  /** Remove a domain and every type of it. False when it was not registered. */
  unregisterDomain(namespace: string): boolean {
    return this.#domains.delete(namespace);
  }

  /** Add one type to its registered domain (the domain of its first segment). */
  register(type: string, definition: ExtensionType): () => void {
    const entry = this.#domains.get(extensionNamespace(type));
    if (entry === undefined) {
      throw new TypeError(`no domain "${extensionNamespace(type)}" is registered for "${type}"`);
    }
    checkType(entry, type, definition);
    entry.types.set(type, definition);
    return () => {
      if (entry.types.get(type) === definition) entry.types.delete(type);
    };
  }

  /** Remove one type. False when it was not registered. */
  unregister(type: string): boolean {
    return this.#domains.get(extensionNamespace(type))?.types.delete(type) ?? false;
  }

  /** The registered type, with its domain; undefined when no domain builds it. */
  lookup(type: string): RegisteredExtension | undefined {
    const entry = this.#domains.get(extensionNamespace(type));
    const definition = entry?.types.get(type);
    if (entry === undefined || definition === undefined) return undefined;
    return {
      type,
      definition,
      namespace: entry.namespace,
      implementation: entry.implementation,
      reads: entry.reads,
    };
  }

  /**
   * The namespaces an extension of `type` may read: its registered domain's own and shared ones,
   * or, for a type no domain is registered for, just its own namespace.
   */
  readsOf(type: string): readonly string[] {
    const ns = extensionNamespace(type);
    return this.#domains.get(ns)?.reads ?? [ns];
  }

  /** The reader of a namespace of domain data, from the domain that owns it. */
  reader(namespace: string): DomainDataReader | undefined {
    for (const d of this.#domains.values()) {
      const r = d.data.get(namespace);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  /** The member stages of the registered domains, by namespace, sorted. */
  memberStages(): RegisteredMemberStage[] {
    return [...this.#domains.values()]
      .filter((d) => d.members !== undefined)
      .sort((a, b) => a.namespace.localeCompare(b.namespace))
      .map((d) => ({
        namespace: d.namespace,
        implementation: d.implementation,
        reads: d.reads,
        stage: d.members!,
      }));
  }

  /** Registered domain namespaces, sorted. */
  get namespaces(): string[] {
    return [...this.#domains.keys()].sort();
  }

  #owner(namespace: string): string | undefined {
    for (const d of this.#domains.values()) if (d.data.has(namespace)) return d.namespace;
    return undefined;
  }
}

function checkVersion(v: number, what: string): void {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new TypeError(`${what}: the schema version must be an integer from 1`);
  }
}

function checkType(entry: DomainEntry, type: string, definition: ExtensionType): void {
  if (!EXTENSION_TYPE_PATTERN.test(type) || extensionNamespace(type) !== entry.namespace) {
    throw new TypeError(`"${type}" is not a type of domain "${entry.namespace}"`);
  }
  if (entry.types.has(type)) throw new TypeError(`"${type}" is already registered`);
  if (typeof definition?.translate !== 'function') {
    throw new TypeError(`"${type}" has no translate function`);
  }
  checkVersion(definition.schemaVersion, `"${type}"`);
}

/**
 * The registry an engine uses when its options name none. The regen worker's entry in the app
 * registers the domains the app ships here at start-up.
 */
export const defaultExtensions = new ExtensionRegistry();

// What the engine asks of this module ------------------------------------------------------------

/** Run domain code; a throw becomes an `extension` error naming the step. */
export function guard<T>(
  type: string,
  step: string,
  call: () => T,
): { ok: true; value: T } | { ok: false; error: RegenError } {
  try {
    return { ok: true, value: call() };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: { code: 'extension', message: `The "${type}" ${step} failed: ${why}` },
    };
  }
}

/**
 * Whether this build can read the feature: its type is registered and its `schemaVersion` is not
 * newer than the type's. Otherwise the `unsupported` error naming the type and both versions.
 */
export function supported(
  registry: ExtensionRegistry,
  f: ExtensionFeature,
): { ok: true; extension: RegisteredExtension } | { ok: false; error: RegenError } {
  const found = registry.lookup(f.extension);
  if (found === undefined) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        field: ['extension'],
        message: `This build has no domain for "${f.extension}" features (version ${f.schemaVersion}): it makes no geometry here; open the document in a build that ships the "${extensionNamespace(f.extension)}" domain`,
      },
    };
  }
  if (f.schemaVersion > found.definition.schemaVersion) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        field: ['schemaVersion'],
        message: `"${f.extension}" version ${f.schemaVersion} is newer than this build reads (version ${found.definition.schemaVersion}): open the document in a newer build`,
      },
    };
  }
  return { ok: true, extension: found };
}

/**
 * The domain data an extension may read, each namespace read by the domain that owns it. One
 * error (newer version, invalid data, no owner) fails every extension that reads the namespace:
 * a board must not silently fall back to catalog values (ADR 0013 decision 4). `memo` holds the
 * outcome per namespace for one document.
 */
export function readDomainData(
  registry: ExtensionRegistry,
  extension: Pick<RegisteredExtension, 'reads'>,
  domains: Domains | undefined,
  memo: Map<string, NamespaceRead>,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: RegenError } {
  const data: Record<string, unknown> = {};
  for (const ns of extension.reads) {
    const entry = domains !== undefined && Object.hasOwn(domains, ns) ? domains[ns] : undefined;
    if (entry === undefined) continue;
    let got = memo.get(ns);
    if (got === undefined) {
      got = readNamespace(registry, ns, entry);
      memo.set(ns, got);
    }
    if (!got.ok) return got;
    data[ns] = got.value;
  }
  return { ok: true, data };
}

/** One namespace of domain data as its owner read it, or the error every reader of it fails with. */
export type NamespaceRead = { ok: true; value: unknown } | { ok: false; error: RegenError };

function readNamespace(registry: ExtensionRegistry, ns: string, entry: DomainData): NamespaceRead {
  const fail = (code: 'unsupported' | 'extension', message: string): NamespaceRead =>
    code === 'unsupported'
      ? { ok: false, error: { code, message, field: ['domains', ns] } }
      : { ok: false, error: { code, message } };
  const reader = registry.reader(ns);
  if (reader === undefined) {
    return fail(
      'unsupported',
      `The domain data "${ns}" cannot be read: no domain in this build owns it`,
    );
  }
  if (entry.schemaVersion > reader.schemaVersion) {
    return fail(
      'unsupported',
      `The domain data "${ns}" is version ${entry.schemaVersion}, newer than this build reads (version ${reader.schemaVersion})`,
    );
  }
  let got: unknown;
  try {
    got = reader.read(entry.data, entry.schemaVersion);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return fail('extension', `Reading the domain data "${ns}" failed: ${why}`);
  }
  if (!isReadResult(got)) {
    return fail('extension', `Reading the domain data "${ns}" gave a malformed result`);
  }
  if (got.ok) return { ok: true, value: got.value };
  return {
    ok: false,
    error: {
      code: 'invalid',
      field: ['domains', ns, 'data', ...(fieldOf(got).field ?? [])],
      message: `The domain data "${ns}" is invalid: ${got.message}`,
    },
  };
}

function fieldOf(r: { field?: FieldPath }): { field?: FieldPath } {
  return Array.isArray(r.field) ? { field: r.field } : {};
}

function isReadResult(r: unknown): r is ReadResult<unknown> {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { ok?: unknown; message?: unknown };
  return o.ok === true || (o.ok === false && typeof o.message === 'string');
}

/** The params as the type reads them (migrated and validated), or the `invalid` error. */
export function readParams(
  extension: RegisteredExtension,
  f: ExtensionFeature,
): { ok: true; params: unknown } | { ok: false; error: RegenError } {
  const read = extension.definition.params;
  if (read === undefined) return { ok: true, params: f.params };
  const got = guard(f.extension, 'params check', () =>
    read.call(extension.definition, f.params, f.schemaVersion),
  );
  if (!got.ok) return got;
  if (!isReadResult(got.value)) {
    return {
      ok: false,
      error: {
        code: 'extension',
        message: `The "${f.extension}" params check gave a malformed result`,
      },
    };
  }
  if (!got.value.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid',
        field: ['params', ...(fieldOf(got.value).field ?? [])],
        message: got.value.message,
      },
    };
  }
  return { ok: true, params: got.value.value };
}

/** Every expression evaluated with its declared kind (undeclared: a plain number). */
export function evaluateExtension(
  extension: RegisteredExtension,
  f: ExtensionFeature,
  variables: VariableValues,
): { values: Record<string, number>; errors: RegenError[] } {
  const values: Record<string, number> = {};
  const errors: RegenError[] = [];
  const kinds = extension.definition.expressions ?? {};
  for (const name of Object.keys(f.expressions).sort()) {
    const expression = f.expressions[name]!;
    const field = ['expressions', name];
    const kind = Object.hasOwn(kinds, name) ? kinds[name] : undefined;
    if (kind !== undefined) {
      const r =
        kind === 'slope'
          ? evaluateField(expression, 'angle', field, variables, { slope: true })
          : evaluateField(expression, kind, field, variables);
      if (r.ok) values[name] = r.value;
      else errors.push(r.error);
      continue;
    }
    const r = evaluateQuantity(expression.source, {
      lengthUnit: expression.lengthUnit,
      angleUnit: expression.angleUnit,
      variables: (n) => variables.values.get(n),
    });
    if (r.ok) values[name] = r.value.value;
    else {
      errors.push({
        code: 'expression',
        message: `${field.join('.')}: ${r.error.message}`,
        field,
        error: r.error,
      });
    }
  }
  return { values, errors };
}

/**
 * Whether `queries` returned a list of well-formed queries, copied out as plain data: a resolve
 * names a face (`{ face }`) or an edge (`{ faces, ends?, ordinal? }`) by strings, an obb names a
 * body. Anything else, including a getter that throws, is an `extension` error.
 */
export function checkQueries(
  type: string,
  out: unknown,
): { ok: true; queries: GeometryQuery[] } | { ok: false; error: RegenError } {
  const bad = (why: string) => ({
    ok: false as const,
    error: { code: 'extension' as const, message: `The "${type}" queries are malformed: ${why}` },
  });
  try {
    if (isFailure(out)) return { ok: false, error: failureError(out) };
    if (!Array.isArray(out)) return bad('expected a list of queries or an error');
    const queries: GeometryQuery[] = [];
    for (const [i, q] of out.entries()) {
      if (typeof q !== 'object' || q === null) return bad(`query ${i} is not an object`);
      const query = q as { type?: unknown; ref?: unknown; body?: unknown };
      if (query.type === 'resolve') {
        const ref = topoRefOf(query.ref);
        if (ref === null) return bad(`query ${i} has no well-formed ref`);
        queries.push({ type: 'resolve', ref });
      } else if (query.type === 'obb') {
        if (typeof query.body !== 'string') return bad(`query ${i} names no body`);
        queries.push({ type: 'obb', body: query.body });
      } else {
        return bad(`query ${i} has the unknown type ${JSON.stringify(query.type)}`);
      }
    }
    return { ok: true, queries };
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A face or edge reference copied out as plain data, or null when it is not one. */
function topoRefOf(raw: unknown): TopoRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const ref = raw as { face?: unknown; faces?: unknown; ends?: unknown; ordinal?: unknown };
  if ('face' in ref) return typeof ref.face === 'string' ? { face: ref.face } : null;
  if (!isStrings(ref.faces) || ref.faces.length === 0) return null;
  const edge: EdgeRef = { faces: [...ref.faces] };
  if (ref.ends !== undefined) {
    if (!isStrings(ref.ends)) return null;
    edge.ends = [...ref.ends];
  }
  if (ref.ordinal !== undefined) {
    if (typeof ref.ordinal !== 'number' || !Number.isInteger(ref.ordinal)) return null;
    edge.ordinal = ref.ordinal;
  }
  return edge;
}

function isFailure(out: unknown): out is ExtensionFailure {
  return typeof out === 'object' && out !== null && 'error' in out;
}

function failureError(out: ExtensionFailure): RegenError {
  const error: RegenError = {
    code: 'invalid',
    message: typeof out.error === 'string' ? out.error : 'The feature cannot be built',
  };
  if (Array.isArray(out.field)) error.field = out.field;
  if (typeof out.referenceId === 'string') error.referenceId = out.referenceId;
  return error;
}

const MODES: Record<BooleanOperation, ResultMode> = {
  new: 'new',
  add: 'add',
  cut: 'subtract',
  intersect: 'intersect',
};

/** Kernel inputs a translator may not return: a derive carries live shape ids, not data. */
const REFUSED_KINDS: ReadonlySet<string> = new Set(['derive']);

/**
 * A translator's output checked and given the feature's body semantics (M2 decisions 1 to 3,
 * ADR 0013 decision 6), or the feature's errors:
 *
 * - every input carries the feature's id;
 * - with an `operation`, every input that combines a solid (one with a `mode`) gets the
 *   operation's mode and the feature's `scope`, and with `new` or `add` makes its body under the
 *   feature's id, or `<id>:<key>` when the translator names one;
 * - without one, no input may combine a solid of its own: it changes bodies only through inputs
 *   that name them (a joint's `tools`);
 * - a `scope` entry that is not a body here is a `reference-lost` error on `scope`.
 *
 * A malformed result (a `body` or `scope` that is not strings, two `new` inputs making the same
 * body, a getter that throws) is an `extension` error: domain code never fails the regen.
 */
export function checkOutput(
  f: ExtensionFeature,
  out: unknown,
  bodies: ReadonlySet<string>,
): CheckedOutput {
  try {
    return checkOutputOf(f, out, bodies);
  } catch (error) {
    return malformed(f, error instanceof Error ? error.message : String(error));
  }
}

type CheckedOutput =
  { ok: true; inputs: FeatureInput[]; metadata?: JsonValue } | { ok: false; errors: RegenError[] };

function malformed(f: ExtensionFeature, why: string): { ok: false; errors: RegenError[] } {
  return {
    ok: false,
    errors: [
      {
        code: 'extension',
        message: `The "${f.extension}" translator's result is malformed: ${why}`,
      },
    ],
  };
}

function checkOutputOf(
  f: ExtensionFeature,
  out: unknown,
  bodies: ReadonlySet<string>,
): CheckedOutput {
  if (isFailure(out)) return { ok: false, errors: [failureError(out)] };
  const bad = (why: string) => malformed(f, why);
  if (typeof out !== 'object' || out === null || !Array.isArray((out as ExtensionInputs).inputs)) {
    return bad('expected { inputs } or { error }');
  }
  const given = (out as ExtensionInputs).inputs;
  if (f.operation !== undefined && given.length === 0) {
    return bad(`a "${f.operation}" extension must build at least one input`);
  }
  const inputs: FeatureInput[] = [];
  const made = new Set<string>();
  for (const [i, raw] of given.entries()) {
    if (typeof raw !== 'object' || raw === null) return bad(`input ${i} is not an object`);
    const input = { ...raw } as FeatureInput & {
      mode?: ResultMode;
      scope?: readonly string[];
      body?: string;
    };
    if (typeof input.kind !== 'string') return bad(`input ${i} has no kind`);
    if (REFUSED_KINDS.has(input.kind)) return bad(`input ${i} is a ${input.kind}`);
    if (input.id !== f.id) {
      return bad(`input ${i} has the id ${JSON.stringify(input.id)}, not the feature's ${f.id}`);
    }
    if (input.body !== undefined && typeof input.body !== 'string') {
      return bad(`input ${i} has a body that is not a string`);
    }
    if (input.scope !== undefined && !isStrings(input.scope)) {
      return bad(`input ${i} has a scope that is not a list of body ids`);
    }
    if ('mode' in input) {
      if (f.operation === undefined) {
        return bad(
          `input ${i} combines a solid (mode ${JSON.stringify(input.mode)}), but the feature has no operation`,
        );
      }
      input.mode = MODES[f.operation];
      if (f.scope !== undefined) input.scope = [...f.scope];
      else delete input.scope;
      if (f.operation === 'new' || f.operation === 'add') {
        if (input.body === undefined) input.body = f.id;
        else if (input.body !== f.id && !input.body.startsWith(`${f.id}:`)) {
          return bad(
            `input ${i} makes the body ${JSON.stringify(input.body)}, not ${f.id} or ${f.id}:<key>`,
          );
        }
        // Each new body once: an `add` input may land in a body an earlier one made.
        if (f.operation === 'new') {
          if (made.has(input.body) || bodies.has(input.body)) {
            return bad(`input ${i} makes the body ${input.body} a second time: give each a key`);
          }
          made.add(input.body);
        }
      } else {
        delete input.body;
      }
    }
    inputs.push(input);
  }
  if (f.scope !== undefined) {
    const missing = f.scope.filter((id) => !bodies.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        errors: [
          {
            code: 'reference-lost',
            referenceId: 'scope',
            missing,
            message: `${f.id} acts on ${missing.join(', ')}, which ${missing.length === 1 ? 'is not a body' : 'are not bodies'} at this point (merged into another, or never made): re-pick the bodies`,
          },
        ],
      };
    }
  }
  const metadata = (out as ExtensionInputs).metadata;
  try {
    // Inputs and metadata are hashed into cache keys and cross the worker boundary: plain data.
    stableStringify([inputs, metadata ?? null]);
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
  return metadata === undefined ? { ok: true, inputs } : { ok: true, inputs, metadata };
}

/** The cache key part of an extension (ADR 0013 decision 5): type, its version, the domain's. */
export function extensionKey(
  extension: RegisteredExtension,
  f: ExtensionFeature,
  part: number,
  of: number,
): Record<string, unknown> {
  return {
    type: f.extension,
    schemaVersion: f.schemaVersion,
    implementation: extension.implementation,
    // One kernel op per input: which of them this is.
    part: [part, of],
  };
}
