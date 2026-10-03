// Domain views (M6 plan T6.4a, ADR 0015 decision 9): views a domain draws from its own data, for
// a drawing view whose source is `{ domain, part, schemaVersion, params }` (format v15). The
// construction domain draws floor plans, framing elevations and roof framing plans this way.
//
// A domain's `drawings.view` is pure: from the view's params, the part's built extensions of its
// namespace (with their metadata), the part's member sets and the domain data, it returns the
// view's frame, an optional section plane, which of the part's bodies the kernel projects (layer
// bodies cut by a plan's section), and the analytic parts in model space: lines and arcs (member
// outlines and cut lines, member sections, door swings), chained dimension strings, roof pitch
// symbols, and a note for the title block (the "not an engineering tool" text). The
// drawing stage (`drawing.ts`) projects them with the view's frame and hands them to
// `packages/drawing`. Nothing a domain view computes is stored; chained strings are derived at
// every request (ADR 0015: no stored domain references or chain dimensions).
//
// What a domain returns is checked here before anything uses it: every count bounded, every
// number finite and within `MAX_MEMBER_SIZE`, directions non-zero, text bounded. A throw or a
// malformed result is a view diagnostic, never a failed request.

import type { JsonValue } from './extensions';
import { MAX_MEMBER_SIZE, type MemberData, type MemberFeature } from './members';

export type DomainVec3 = readonly [number, number, number];

/** The layers a domain view draws its lines on (`packages/drawing`'s names). */
export const DOMAIN_VIEW_LAYERS = ['visible', 'hidden', 'smooth', 'centre', 'section'] as const;
export type DomainViewLayer = (typeof DOMAIN_VIEW_LAYERS)[number];

/** Bounds on what one domain view returns. */
export const MAX_DOMAIN_VIEW_LINES = 400_000;
export const MAX_DOMAIN_VIEW_ARCS = 20_000;
export const MAX_DOMAIN_VIEW_CHAINS = 2_000;
export const MAX_DOMAIN_CHAIN_POINTS = 1_000;
export const MAX_DOMAIN_CHAIN_MARKS = 5_000;
/** Chain points and marks of one view together. */
export const MAX_DOMAIN_VIEW_CHAIN_ITEMS = 200_000;
export const MAX_DOMAIN_VIEW_SYMBOLS = 1_000;
export const MAX_DOMAIN_VIEW_BODIES = 10_000;
export const MAX_DOMAIN_VIEW_WARNINGS = 100;
export const MAX_DOMAIN_TITLE_NOTE_LENGTH = 2_000;
/**
 * What all the domain views of one drawing request may draw together (`domainViewCost`): a sheet
 * holds up to 10,000 views, so per-view bounds alone do not bound a request. Once spent, later
 * domain views draw nothing, with a `domain-view` warning.
 */
export const MAX_REQUEST_DOMAIN_ITEMS = 4 * MAX_DOMAIN_VIEW_LINES;
/** Paper mm: the farthest a chain may sit from its points. */
export const MAX_CHAIN_OFFSET = 1_000;

export interface DomainLine {
  readonly a: DomainVec3;
  readonly b: DomainVec3;
  /** Default `visible`. */
  readonly layer?: DomainViewLayer;
}

/**
 * A circular arc in model space: about `center`, counter-clockwise about the unit-izable `normal`
 * from `from` to `to` (both on the circle). Drawn as an arc when the view looks along its normal,
 * as a polyline otherwise.
 */
export interface DomainArc {
  readonly center: DomainVec3;
  readonly normal: DomainVec3;
  readonly from: DomainVec3;
  readonly to: DomainVec3;
  readonly layer?: DomainViewLayer;
}

/**
 * A chained dimension string (`packages/drawing`'s `ChainDimensionInput`) in model space: its
 * points in order along the line, `side` a model direction pointing from the points to where the
 * string goes, `offset` paper mm. `kind` as for a linear dimension, in the view.
 */
export interface DomainChain {
  /** Unique in the view: `<feature id>:<what>`, made into the chain's owner id. */
  readonly id: string;
  readonly kind: 'horizontal' | 'vertical' | 'aligned';
  readonly points: readonly DomainVec3[];
  readonly side: DomainVec3;
  readonly offset: number;
  readonly overall?: boolean;
  readonly marks?: readonly DomainVec3[];
}

/** A roof pitch symbol at `at` (on the roof line), rising along the model direction `rises`. */
export interface DomainPitch {
  readonly id: string;
  readonly at: DomainVec3;
  /** Radians above horizontal. */
  readonly pitch: number;
  readonly rises: DomainVec3;
}

export interface DomainViewOutput {
  /** The view's frame: the way the viewer looks, and the model direction up on the paper. */
  readonly direction: DomainVec3;
  readonly up: DomainVec3;
  /** A section: the part on the side `normal` points to is removed (core's convention). */
  readonly section?: { readonly origin: DomainVec3; readonly normal: DomainVec3 };
  /** Body ids of the part the kernel projects (with the section); may be empty. */
  readonly bodies: readonly string[];
  readonly lines?: readonly DomainLine[];
  readonly arcs?: readonly DomainArc[];
  readonly chains?: readonly DomainChain[];
  readonly pitches?: readonly DomainPitch[];
  /** Drawn with the title block of every sheet showing the view (a disclaimer). */
  readonly titleNote?: string;
  /** What the domain could not draw as asked; shown as view diagnostics. */
  readonly warnings?: readonly { readonly message: string; readonly code?: string }[];
}

/** One member set of the part, as the last regen framed it. */
export interface DomainViewSet {
  /** The group's id (a wall's, floor's or roof's feature id). */
  readonly group: string;
  readonly members: readonly MemberData[];
  /** The member stage's derived metadata for the group (a roof's geometry). */
  readonly metadata?: JsonValue;
}

export type ExpressionResult = { ok: true; value: number } | { ok: false; message: string };

export interface DomainViewContext {
  readonly partId: string;
  /** The view's params as stored, at `schemaVersion`; the domain migrates and checks them. */
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly schemaVersion: number;
  /** Every extension of the domain's namespace that built in the part, in feature order. */
  readonly features: readonly MemberFeature[];
  /** The part's member sets of the domain's namespace. */
  readonly sets: readonly DomainViewSet[];
  /** The domain data the domain reads, as for its translators. */
  readonly data: Readonly<Record<string, unknown>>;
  /** The part's body ids. */
  readonly bodies: readonly string[];
  /**
   * Evaluate a stored expression in the params (`{ source, lengthUnit, angleUnit }`) with the
   * document's variables: mm, radians or a number by `kind`.
   */
  evaluate(expression: unknown, kind: 'length' | 'angle' | 'number'): ExpressionResult;
}

/** A domain's views. Methods, so a domain's typed object registers where this one is expected. */
export interface DomainDrawings {
  /** The newest `schemaVersion` of view params this build reads. */
  readonly schemaVersion: number;
  /**
   * Text for the title block of every sheet that shows the domain: a view of it (drawn or not),
   * or any view of a part (or of an assembly with an instance of a part) holding an extension
   * feature of its namespace. The construction domain's disclaimer. At most
   * `MAX_DOMAIN_TITLE_NOTE_LENGTH` characters.
   */
  readonly titleNote?: string;
  view(context: DomainViewContext): DomainViewOutput | { error: string };
}

// Checking ---------------------------------------------------------------------------------------

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_MEMBER_SIZE;

function vec(v: unknown, what: string, nonZero = false): DomainVec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNumber)) {
    throw new TypeError(`${what} is not three numbers of at most ${MAX_MEMBER_SIZE} mm`);
  }
  const out: DomainVec3 = [v[0] as number, v[1] as number, v[2] as number];
  if (nonZero && !(Math.hypot(...out) > 1e-12)) throw new TypeError(`${what} is a zero vector`);
  return out;
}

function list(v: unknown, max: number, what: string): readonly unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TypeError(`${what} is not a list`);
  if (v.length > max) throw new TypeError(`${what}: ${v.length}, more than the ${max} allowed`);
  return v;
}

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what} is not text`);
  if (v.length > max) throw new TypeError(`${what} is longer than ${max} characters`);
  return v;
}

function layer(v: unknown, what: string): DomainViewLayer {
  if (v === undefined) return 'visible';
  if (typeof v !== 'string' || !(DOMAIN_VIEW_LAYERS as readonly string[]).includes(v)) {
    throw new TypeError(`${what} is not a layer a domain view draws on`);
  }
  return v as DomainViewLayer;
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new TypeError(`${what} is not an object`);
  }
  return v as Record<string, unknown>;
};

/** A domain view's output, checked and copied (or why it is malformed). Linear in its size. */
export function checkDomainView(
  out: unknown,
): { ok: true; view: DomainViewOutput } | { ok: false; message: string } {
  try {
    const o = obj(out, 'the view');
    if ('error' in o) return { ok: false, message: text(o.error, 2_000, 'the error') };
    const direction = vec(o.direction, 'the direction', true);
    const up = vec(o.up, 'up', true);
    const cross = Math.hypot(
      direction[1] * up[2] - direction[2] * up[1],
      direction[2] * up[0] - direction[0] * up[2],
      direction[0] * up[1] - direction[1] * up[0],
    );
    if (!(cross / (Math.hypot(...direction) * Math.hypot(...up)) > 1e-9)) {
      throw new TypeError('up is parallel to the direction');
    }
    let section: DomainViewOutput['section'];
    if (o.section !== undefined) {
      const s = obj(o.section, 'the section');
      section = {
        origin: vec(s.origin, 'the section origin'),
        normal: vec(s.normal, 'the section normal', true),
      };
    }
    const bodies = list(o.bodies, MAX_DOMAIN_VIEW_BODIES, 'the bodies').map((b, i) =>
      text(b, 4096, `body ${i}`),
    );
    const lines = list(o.lines, MAX_DOMAIN_VIEW_LINES, 'the lines').map((l, i): DomainLine => {
      const x = obj(l, `line ${i}`);
      return {
        a: vec(x.a, `line ${i}`),
        b: vec(x.b, `line ${i}`),
        layer: layer(x.layer, `line ${i}'s layer`),
      };
    });
    const arcs = list(o.arcs, MAX_DOMAIN_VIEW_ARCS, 'the arcs').map((l, i): DomainArc => {
      const x = obj(l, `arc ${i}`);
      return {
        center: vec(x.center, `arc ${i}`),
        normal: vec(x.normal, `arc ${i}'s normal`, true),
        from: vec(x.from, `arc ${i}`),
        to: vec(x.to, `arc ${i}`),
        layer: layer(x.layer, `arc ${i}'s layer`),
      };
    });
    let chainItems = 0;
    const ids = new Set<string>();
    const chains = list(o.chains, MAX_DOMAIN_VIEW_CHAINS, 'the chains').map((c, i): DomainChain => {
      const x = obj(c, `chain ${i}`);
      const id = text(x.id, 200, `chain ${i}'s id`);
      if (ids.has(id)) throw new TypeError(`chain id ${id} is used twice`);
      ids.add(id);
      const kind = x.kind;
      if (kind !== 'horizontal' && kind !== 'vertical' && kind !== 'aligned') {
        throw new TypeError(`chain ${id} has no kind`);
      }
      const rawPoints = list(x.points, MAX_DOMAIN_CHAIN_POINTS, `chain ${id}'s points`);
      const rawMarks = list(x.marks, MAX_DOMAIN_CHAIN_MARKS, `chain ${id}'s marks`);
      chainItems += rawPoints.length + rawMarks.length;
      if (chainItems > MAX_DOMAIN_VIEW_CHAIN_ITEMS) {
        throw new TypeError(`the chains have more than ${MAX_DOMAIN_VIEW_CHAIN_ITEMS} points`);
      }
      if (!isNumber(x.offset) || Math.abs(x.offset) > MAX_CHAIN_OFFSET) {
        throw new TypeError(`chain ${id}'s offset is not a number of at most ${MAX_CHAIN_OFFSET}`);
      }
      if (x.overall !== undefined && typeof x.overall !== 'boolean') {
        throw new TypeError(`chain ${id}'s overall is not true or false`);
      }
      return {
        id,
        kind,
        points: rawPoints.map((p, j) => vec(p, `chain ${id}'s point ${j}`)),
        side: vec(x.side, `chain ${id}'s side`, true),
        offset: x.offset,
        ...(x.overall === undefined ? {} : { overall: x.overall }),
        ...(x.marks === undefined
          ? {}
          : { marks: rawMarks.map((p, j) => vec(p, `chain ${id}'s mark ${j}`)) }),
      };
    });
    const pitches = list(o.pitches, MAX_DOMAIN_VIEW_SYMBOLS, 'the pitch symbols').map(
      (p, i): DomainPitch => {
        const x = obj(p, `pitch symbol ${i}`);
        if (!isNumber(x.pitch) || !(x.pitch > 0 && x.pitch < Math.PI / 2)) {
          throw new TypeError(`pitch symbol ${i} has no pitch above 0 and below 90 degrees`);
        }
        return {
          id: text(x.id, 200, `pitch symbol ${i}'s id`),
          at: vec(x.at, `pitch symbol ${i}`),
          pitch: x.pitch,
          rises: vec(x.rises, `pitch symbol ${i}'s direction`, true),
        };
      },
    );
    const warnings = list(o.warnings, MAX_DOMAIN_VIEW_WARNINGS, 'the warnings').map((w, i) => {
      const x = obj(w, `warning ${i}`);
      return {
        message: text(x.message, 2_000, `warning ${i}`),
        ...(x.code === undefined ? {} : { code: text(x.code, 100, `warning ${i}'s code`) }),
      };
    });
    const titleNote =
      o.titleNote === undefined
        ? undefined
        : text(o.titleNote, MAX_DOMAIN_TITLE_NOTE_LENGTH, 'the title note');
    return {
      ok: true,
      view: {
        direction,
        up,
        ...(section === undefined ? {} : { section }),
        bodies,
        lines,
        arcs,
        chains,
        pitches,
        warnings,
        ...(titleNote === undefined ? {} : { titleNote }),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** What a checked view draws, for the request budget: lines, arcs, string points and marks, symbols. */
export function domainViewCost(view: DomainViewOutput): number {
  let n = (view.lines?.length ?? 0) + (view.arcs?.length ?? 0) + (view.pitches?.length ?? 0);
  for (const c of view.chains ?? []) n += c.points.length + (c.marks?.length ?? 0);
  return n;
}
