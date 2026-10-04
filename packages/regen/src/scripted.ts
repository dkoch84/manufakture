// Scripted features in the regen worker (ADR 0010; T7.2c): the QuickJS engine loaded once per
// worker, one script instance per document (a pinned source document of a derived part counts
// as a document of its own: decision 4), the cache key of a scripted feature (decision 5), the
// parameters a run receives, and its errors as regen errors with source positions.
//
// The hard bound on a run is outside: a script holds this worker for its whole run, and a few
// native loops (unary `+` on a huge string, object spread of a huge object; the residual cases
// of `@manufakture/script`'s README) are not stopped by the soft limits. So the engine reports
// each run's start and end (`ScriptRunEvent`), and `RegenClient` on the main thread terminates
// and restarts the worker when a run has not ended after `RECOMMENDED_HARD_TIMEOUT_MS`; it then
// hands the new worker the runaway run's cache key, and the engine fails that feature with a
// `timeout` instead of running it again (so a restart never loops).

import type { ScriptedFeature, ScriptParamValue, StoredExpression } from '@manufakture/core';
import {
  QUICKJS_BUILD,
  RECOMMENDED_HARD_TIMEOUT_MS,
  checkApiVersion,
  scriptError,
  type ParamSpec,
  type ScriptEngine,
  type ScriptError,
  type ScriptInstance,
  type ScriptLimits,
  type ScriptValue,
} from '@manufakture/script';
import { SCRIPT_APIS } from './script-api';
import type { FieldPath, RegenError } from './types';
import { evaluateField, type VariableValues } from './values';

/** A script run starting or ending in the worker, for the watchdog on the main thread. */
export interface ScriptRunEvent {
  phase: 'start' | 'end';
  /** The scripted feature (informational). */
  featureId: string;
  /** The feature's cache key: what a runaway run is remembered by. */
  key: string;
}

export interface ScriptOptions {
  /**
   * Loads the QuickJS engine, once per engine: `ScriptEngine.load({ url })` with the `.wasm`
   * asset URL in a browser worker, `nodeScriptEngine()` (`@manufakture/script/node`) in Node.
   */
  engine: () => Promise<ScriptEngine>;
  /** Limits for every run and instance (`@manufakture/script`'s defaults otherwise). */
  limits?: Partial<ScriptLimits>;
  /** Told when each script run starts and ends (declarations and `run` alike). */
  onRun?: (event: ScriptRunEvent) => void;
}

/** What the script host has done (for tests and the stats page). */
export interface ScriptStats {
  /** Declaration runs (top-level code only). */
  declarations: number;
  /** `run(ctx, params)` calls. */
  runs: number;
  /** Instances made (one per document, more after a fatal error recycled one). */
  instances: number;
}

/** The QuickJS engine and the per-document instances of one regen engine. */
export class ScriptHost {
  readonly #options: ScriptOptions;
  #engine: Promise<ScriptEngine> | null = null;
  readonly #instances = new Map<string, Promise<ScriptInstance>>();
  #monitor: ((event: ScriptRunEvent) => void) | null;
  readonly #runaway = new Set<string>();
  readonly #fatal = new Set<string>();
  readonly stats: ScriptStats = { declarations: 0, runs: 0, instances: 0 };

  constructor(options: ScriptOptions) {
    this.#options = options;
    this.#monitor = options.onRun ?? null;
  }

  get limits(): Partial<ScriptLimits> {
    return this.#options.limits ?? {};
  }

  /** Replace the run monitor (the worker API sets the main thread's). */
  setMonitor(monitor: ((event: ScriptRunEvent) => void) | null): void {
    this.#monitor = monitor;
  }

  /** Cache keys of runs the watchdog stopped: they fail with `timeout` and are not run again. */
  addRunaway(keys: Iterable<string>): void {
    for (const key of keys)
      if (typeof key === 'string' && key.length <= 256) this.#runaway.add(key);
  }

  isRunaway(key: string): boolean {
    return this.#runaway.has(key);
  }

  /**
   * Remember the cache key of a run whose kernel session failed fatally (the kernel ran out of
   * memory or trapped, and is recycled). The recycle drops every cached body and the host
   * regenerates, so running the same key again would recycle again, forever: an untrusted
   * document could keep the app busy that way. Such a feature fails with `sessionFatalError`
   * until an edit changes its key.
   */
  addSessionFatal(key: string): void {
    this.#fatal.add(key);
  }

  isSessionFatal(key: string): boolean {
    return this.#fatal.has(key);
  }

  event(phase: 'start' | 'end', featureId: string, key: string): void {
    try {
      this.#monitor?.({ phase, featureId, key });
    } catch {
      // A broken monitor must not break the regen.
    }
  }

  /** The instance of a document: `''` for the document being regenerated, else a source's namespace. */
  instance(document: string): Promise<ScriptInstance> {
    let got = this.#instances.get(document);
    if (got === undefined) {
      this.#engine ??= this.#options.engine();
      got = this.#engine.then((engine) => {
        this.stats.instances++;
        return engine.createInstance({ limits: this.limits });
      });
      // A failed load is retried on the next run, not cached.
      got.catch(() => {
        if (this.#instances.get(document) === got) this.#instances.delete(document);
        this.#engine = null;
      });
      this.#instances.set(document, got);
    }
    return got;
  }

  /** Drop every instance (the engine is disposed). */
  async dispose(): Promise<void> {
    const all = [...this.#instances.values()];
    this.#instances.clear();
    for (const p of all) {
      try {
        (await p).dispose();
      } catch {
        // Never made.
      }
    }
  }
}

/** What the user sees for a `host-error`: a bug on our side, whose raw text is not for the UI. */
export const HOST_ERROR_MESSAGE =
  'The script stopped because of an internal error in the app (not in the script)';

/**
 * A script failure as the feature's regen error. A `host-error` is a host function or kernel
 * failing in a way the script did not cause: its raw exception text can hold internals, so the
 * message is fixed and the text goes to `detail` (for debug logs, never shown).
 */
export function scriptRegenError(scriptId: string, e: ScriptError): RegenError {
  const out: RegenError =
    e.code === 'host-error'
      ? {
          code: 'script',
          scriptCode: e.code,
          scriptId,
          message: HOST_ERROR_MESSAGE,
          detail: e.message,
        }
      : { code: 'script', scriptCode: e.code, scriptId, message: e.message };
  if (e.line !== undefined) out.line = e.line;
  if (e.column !== undefined) out.column = e.column;
  if (e.stack !== undefined) out.stack = e.stack;
  return out;
}

/** The error of a run the worker's watchdog stopped (see the module comment). */
export function runawayError(scriptId: string): RegenError {
  return scriptRegenError(
    scriptId,
    scriptError(
      'timeout',
      `The script was still running after ${RECOMMENDED_HARD_TIMEOUT_MS / 1000} s and was stopped (the regen worker was restarted); change the script or its parameters to run it again`,
    ),
  );
}

/** The error of a feature whose last run took the kernel down (see `ScriptHost.addSessionFatal`). */
export function sessionFatalError(scriptId: string): RegenError {
  return {
    code: 'script',
    scriptCode: 'session-fatal',
    scriptId,
    message:
      'The script made the geometry kernel fail (out of memory or a crash) and the kernel was restarted; change the script or its parameters to run it again',
  };
}

/** Null when this build runs the script's API version, else the error to report. */
export function apiVersionError(scriptId: string, apiVersion: number): RegenError | null {
  const e = checkApiVersion(apiVersion);
  if (e !== null) return scriptRegenError(scriptId, e);
  if (!SCRIPT_APIS.has(apiVersion)) {
    // The script package runs a version regen has no `ctx` for: a build mismatch.
    return scriptRegenError(
      scriptId,
      scriptError('api-version', `This build has no script API version ${apiVersion}.`),
    );
  }
  return null;
}

/**
 * What a scripted feature's cache key hashes besides its versions and the keys of the bodies it
 * reads (ADR 0010 decision 5): the script as stored (source, language, API version), the
 * QuickJS build, the seed, every stored parameter value (an expression by its source and units),
 * and the values of the variables those expressions read. The values a run receives follow from
 * these and from the script's declarations, which follow from its source, so equal keys give
 * equal runs. The feature id is in it too: every body and face a run makes carries it
 * (`scripted#2:boss`, `scripted#2:boss/cap:end`) and cache hits are not renamed, so a remapped
 * id (sync, a duplicated part), a delete and re-add, or the same script in another part must
 * miss rather than serve names of another feature.
 */
export function scriptedKeyParts(
  f: ScriptedFeature,
  script: { source: string; language: string; apiVersion: number },
  variables: VariableValues,
  read: readonly string[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const name of Object.keys(f.params).sort()) {
    const v = f.params[name]!;
    params[name] =
      v.kind === 'expression'
        ? { kind: v.kind, expression: expressionKey(v.expression) }
        : v.kind === 'reference'
          ? { kind: v.kind, references: v.references.map((r) => [r.id, r.ref]) }
          : v;
  }
  const vars: Record<string, unknown> = {};
  for (const name of read) {
    const value = variables.values.get(name);
    vars[name] = value === undefined ? { error: variables.errors.get(name)?.message ?? '' } : value;
  }
  return {
    featureId: f.id,
    source: script.source,
    language: script.language,
    apiVersion: script.apiVersion,
    quickjs: QUICKJS_BUILD,
    seed: f.seed,
    params,
    variables: vars,
  };
}

function expressionKey(e: StoredExpression): unknown {
  return { source: e.source, lengthUnit: e.lengthUnit, angleUnit: e.angleUnit };
}

/**
 * The values of every declared parameter but references, from the stored values: expressions
 * evaluated as the kind the script declares (`length` in mm, `angle` in radians), so `30deg` in a
 * length parameter is an `expression` error like in any other field. A stored value of the wrong
 * kind (a boolean for a length) is `bad-param`. Undeclared values are ignored; missing ones take
 * the default later (`resolveParams`).
 */
export function scriptParamValues(
  specs: readonly ParamSpec[],
  stored: Readonly<Record<string, ScriptParamValue>>,
  variables: VariableValues,
  scriptId: string,
): { ok: true; values: Record<string, ScriptValue> } | { ok: false; errors: RegenError[] } {
  const values: Record<string, ScriptValue> = {};
  const errors: RegenError[] = [];
  const wrong = (spec: ParamSpec, got: string) =>
    errors.push(
      scriptRegenError(
        scriptId,
        scriptError(
          'bad-param',
          `Parameter "${spec.label ?? spec.name}" is declared as ${spec.kind} but holds a ${got}.`,
        ),
      ),
    );
  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(stored, spec.name)) continue;
    const v = stored[spec.name]!;
    switch (spec.kind) {
      case 'number':
      case 'length':
      case 'angle': {
        if (v.kind !== 'expression') {
          wrong(spec, v.kind);
          break;
        }
        const field: FieldPath = ['params', spec.name, 'expression'];
        const r = evaluateField(v.expression, spec.kind, field, variables);
        if (r.ok) values[spec.name] = r.value;
        else errors.push(r.error);
        break;
      }
      case 'boolean':
        if (v.kind === 'boolean') values[spec.name] = v.value;
        else wrong(spec, v.kind);
        break;
      case 'choice':
        if (v.kind === 'choice') values[spec.name] = v.value;
        else wrong(spec, v.kind);
        break;
      case 'reference':
        if (v.kind !== 'reference') wrong(spec, v.kind);
        break;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
