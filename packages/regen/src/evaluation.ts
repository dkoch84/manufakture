// The domain evaluation stage (ADR 0017 decision 15): an optional hook a domain registers, which
// regen calls once per regen after the parts and assemblies have regenerated. It extends ADR 0013
// decision 5's two-step form, which gave it to translators only: the domain first says what it
// needs measured (`measure`), regen answers with kernel ops in the regen's last batch, and the
// domain then evaluates (`evaluate`), returning its own plain data (the mechanical domain's calc
// records) and warnings.
//
// Containment is the translators': every call goes through `guard`, so a throw is an error on the
// domain's `DomainEvaluationResult`, never a failed regen, and what the domain returns is checked
// here before anything passes it on. A domain caches its own results between regens (the
// mechanical domain keys each check's records by its inputs); regen keeps only the measurements,
// by body key, as it keeps the wall checks'.

import type { ManufaktureDocument } from '@manufakture/core';
import type { BodyMeasure } from '@manufakture/kernel';
import type { Quantity } from '@manufakture/units';
import type {
  AssemblyResult,
  DomainEvaluationResult,
  DomainEvaluationWarning,
  RegenError,
} from './types';

/** The codes a domain's evaluation stage may report; anything else is refused by regen. */
export const DOMAIN_EVALUATION_WARNING_CODES: readonly DomainEvaluationWarning['code'][] = [
  'mech-check',
  'mech-requirement',
  'mech-reference',
  'mech-catalog',
  'mech-budget',
  'erc',
];

/** At most this many measurements per domain and regen; more is a malformed request. */
export const MAX_EVALUATION_QUERIES = 10_000;
/** At most this many warnings per domain and regen; the rest are dropped with a count. */
export const MAX_EVALUATION_WARNINGS = 5_000;

/** A part as the evaluation stage sees it: its final bodies (none when it did not build). */
export interface EvaluatedPart {
  partId: string;
  /** False when the part's features left it with no usable bodies. */
  built: boolean;
  /** Its final body ids, in creator order. */
  bodies: readonly string[];
}

/** Everything the evaluation stage reads. Plain data. */
export interface EvaluationContext {
  /** The document as regenerated (with its active configuration row applied). Do not mutate. */
  document: ManufaktureDocument;
  /**
   * The domain data of the namespaces the domain reads, read by their owners, as translators get
   * it. A namespace the document has no entry for is absent.
   */
  data: Readonly<Record<string, unknown>>;
  /** The variables that evaluated, in internal units (measured ones included). */
  variables: ReadonlyMap<string, Quantity>;
  /** The document's parts, in order. */
  parts: readonly EvaluatedPart[];
  /** The assemblies as solved: instance poses and statuses. */
  assemblies: readonly AssemblyResult[];
}

/** A measurement the first step asks for. */
export type EvaluationQuery =
  /** One final body of a part, measured whole: volume, area, centre of mass, volume inertia. */
  { type: 'body'; part: string; body: string };

/** The answer to an `EvaluationQuery`, in the same position. */
export type EvaluationAnswer = {
  type: 'body';
  part: string;
  body: string;
  /** In the part's coordinates, mm; null when the body is not there or did not measure. */
  measure: BodyMeasure | null;
  message?: string;
};

/** What the second step returns. */
export interface EvaluationOutput {
  /** The domain's result, plain JSON; it documents the shape. */
  data?: DomainEvaluationResult['data'];
  warnings?: readonly DomainEvaluationWarning[];
}

/** A domain's evaluation stage. Methods, so a domain's own context types still register. */
export interface DomainEvaluation {
  /** The first step: what to measure. Absent: nothing; `evaluate` gets no answers. */
  measure?(context: EvaluationContext): readonly EvaluationQuery[];
  /** The second step: the domain's data and warnings, from the context and the answers. */
  evaluate(context: EvaluationContext, answers: readonly EvaluationAnswer[]): EvaluationOutput;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: RegenError };

const malformed = (namespace: string, why: string): { ok: false; error: RegenError } => ({
  ok: false,
  error: {
    code: 'extension',
    message: `The "${namespace}" evaluation returned something malformed: ${why}`,
  },
});

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the first step's queries: a list of at most `MAX_EVALUATION_QUERIES` body queries. */
export function checkEvaluationQueries(
  namespace: string,
  queries: unknown,
): Checked<EvaluationQuery[]> {
  if (!Array.isArray(queries)) return malformed(namespace, 'the queries are not a list');
  if (queries.length > MAX_EVALUATION_QUERIES) {
    return malformed(namespace, `more than ${MAX_EVALUATION_QUERIES} queries`);
  }
  const out: EvaluationQuery[] = [];
  for (const [i, q] of queries.entries()) {
    if (
      !isObject(q) ||
      q.type !== 'body' ||
      typeof q.part !== 'string' ||
      typeof q.body !== 'string'
    ) {
      return malformed(namespace, `query ${i} is not a body query`);
    }
    out.push({ type: 'body', part: q.part, body: q.body });
  }
  return { ok: true, value: out };
}

/**
 * Checks the second step's output: an object whose warnings are a list of the evaluation codes,
 * each with a message, and whose data is plain JSON. Warnings past `MAX_EVALUATION_WARNINGS` are
 * dropped, the last one saying how many.
 */
export function checkEvaluationOutput(
  namespace: string,
  output: unknown,
): Checked<{ data?: DomainEvaluationResult['data']; warnings: DomainEvaluationWarning[] }> {
  if (!isObject(output)) return malformed(namespace, 'not an object');
  const warnings: DomainEvaluationWarning[] = [];
  if (output.warnings !== undefined) {
    if (!Array.isArray(output.warnings)) return malformed(namespace, 'the warnings are not a list');
    for (const [i, w] of output.warnings.entries()) {
      if (
        !isObject(w) ||
        !(DOMAIN_EVALUATION_WARNING_CODES as readonly unknown[]).includes(w.code) ||
        typeof w.message !== 'string'
      ) {
        return malformed(namespace, `warning ${i} has no evaluation code and message`);
      }
      warnings.push(w as DomainEvaluationWarning);
    }
  }
  if (warnings.length > MAX_EVALUATION_WARNINGS) {
    const dropped = warnings.length - MAX_EVALUATION_WARNINGS + 1;
    const last = warnings[MAX_EVALUATION_WARNINGS - 1]!;
    warnings.length = MAX_EVALUATION_WARNINGS - 1;
    warnings.push({ ...last, message: `${dropped} more warnings not shown` });
  }
  if (output.data === undefined) return { ok: true, value: { warnings } };
  let data: DomainEvaluationResult['data'];
  try {
    // Plain JSON only: it crosses the worker boundary and reaches sessions as it is.
    data = JSON.parse(JSON.stringify(output.data)) as DomainEvaluationResult['data'];
  } catch (error) {
    return malformed(
      namespace,
      `the data is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return { ok: true, value: { data, warnings } };
}
