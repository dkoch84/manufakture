// Laser and plasma export (M5 plan, T5.6b): a part's outlines as DXF or SVG for cutting software,
// optionally compensated for the kerf. Kept free of React so it can be tested with a fake geometer.
//
// Where the loops come from:
// - planar faces and sketch regions through the CAM geometry stage (T5.1f; ADR 0014 decisions 5
//   and 7). The stage resolves sources for a setup, so the export asks it for a setup made up for
//   the request and never stored: the chosen part (and body), its up direction from the first
//   face picked (or, for sketch regions alone, the first model axis their sketches lie across),
//   and one profile operation holding the sources. Only the sources' loops are read from the
//   reply; the operation's numbers (its tool, its feeds) are never used and their errors ignored.
// - a section of the body by a plane across a model axis, through the kernel's `section` op (the
//   stage has no plane sections).
//
// Every source becomes loops in one 2D frame: the first source's plane, seen from the side its
// normal points to (`planarLoopsToMachine`, which refuses a plane that is not parallel and mirrors
// one that faces the other way). Sources go to layers by name (the same name, the same layer);
// every loop is compensated on its own (`kerfLoops`: outer loops out and holes in, by half the
// kerf, arcs kept), and the whole drawing is moved so its lower left corner is at (0, 0).

import {
  kerfLoops,
  planarLoopsToMachine,
  type Loop2,
  type PlanarLoops,
  type Segment2,
  type Vec2,
  type Vec3,
  type WcsFrame,
} from '@manufakture/cam';
import {
  bareUnits,
  type CamGeometrySource,
  type CamOperation,
  type CamSetup,
  type CamWcs,
  type FaceRef,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import {
  dxfName,
  fileName,
  layerId,
  loopsToDxf,
  loopsToSheet,
  loopsToSvg,
  sheetBounds,
} from '@manufakture/io';
import type { Frame, Loop as KernelLoop, SectionLoops } from '@manufakture/kernel';
import type { CamGeometryResult, CamStageError } from '@manufakture/regen';
import type { ExportedFile } from '../../io/actions';
import type { ExchangeResult } from '../../io/exchange';
import { MIME } from '../../io/files';
import type { CamGeometer } from '../geometer';

export type LaserFormat = 'dxf' | 'svg';
export type SectionAxis = 'x' | 'y' | 'z';

export const LASER_FORMATS: readonly [LaserFormat, string, string][] = [
  ['dxf', 'DXF', 'ASCII DXF (R2000) in millimetres: closed polylines with exact arcs'],
  ['svg', 'SVG', 'SVG in millimetres: closed paths with arc commands'],
];

/** One thing to export, with the layer it goes to. */
export type LaserSource =
  | { readonly kind: 'face'; readonly ref: FaceRef; readonly label: string; readonly layer: string }
  | {
      readonly kind: 'region';
      readonly sketch: string;
      readonly label: string;
      readonly layer: string;
    }
  | {
      readonly kind: 'section';
      readonly axis: SectionAxis;
      /** Where the plane crosses the axis: the model coordinate along it, mm. */
      readonly position: number;
      readonly label: string;
      readonly layer: string;
    };

/** What is exported: a part, its body when it has several, and that body's viewport id. */
export interface LaserScope {
  readonly partId: string;
  /** The body (core id); absent when the part has one. */
  readonly body?: string;
  /** The body's viewport id, for the section (the kernel shape the scene holds). */
  readonly viewId: string;
}

export interface LaserServices {
  readonly geometer: CamGeometer | null;
  readonly section?:
    | ((
        bodyId: string,
        frame: Frame,
        height: number,
        deflection?: number,
      ) => Promise<ExchangeResult<SectionLoops>>)
    | undefined;
}

export interface LaserLayer {
  readonly name: string;
  readonly loops: readonly Loop2[];
}

export type Extraction =
  | { readonly ok: true; readonly layers: readonly LaserLayer[]; readonly warnings: string[] }
  | { readonly ok: false; readonly messages: string[] };

/**
 * The largest kerf accepted, mm. Laser kerfs are tenths of a millimetre and plasma kerfs one to a
 * few; anything wider is almost certainly a typo or the wrong units.
 */
export const MAX_KERF = 10;

/** A kerf may be at most this fraction of the outline's smaller side. */
export const MAX_KERF_FRACTION = 0.25;

/** Chord deflection of section curves that are not lines or circles, mm (the stage's own). */
export const SECTION_DEFLECTION = 0.01;

/** The synthetic setup's operation; never stored. */
const OPERATION_ID = 'profile#1';

/** The order sketch regions alone try the model axes as their up direction. */
const REGION_AXES = ['+z', '+y', '+x'] as const;

// ---------------------------------------------------------------------------------------------
// Sources

/** A layer name for a new source: its kind and a number, so names stay unique by default. */
export function defaultLayer(kind: LaserSource['kind'], existing: readonly LaserSource[]): string {
  const base = kind === 'face' ? 'face' : kind === 'region' ? 'region' : 'section';
  const taken = new Set(existing.map((s) => s.layer));
  for (let i = 1; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** `list` with the source `make` builds from it, unless the list has that source already. */
export function withSource(
  list: readonly LaserSource[],
  make: (existing: readonly LaserSource[]) => LaserSource,
): readonly LaserSource[] {
  const s = make(list);
  return list.some((x) => sameSource(x, s)) ? list : [...list, s];
}

/** Whether `source` is already in the list (the same face, sketch or plane). */
export function sameSource(a: LaserSource, b: LaserSource): boolean {
  if (a.kind === 'face' && b.kind === 'face') return a.ref.face === b.ref.face;
  if (a.kind === 'region' && b.kind === 'region') return a.sketch === b.sketch;
  if (a.kind === 'section' && b.kind === 'section')
    return a.axis === b.axis && a.position === b.position;
  return false;
}

/**
 * A section plane across `axis` at `position`, as a kernel frame and height: seen as the standard
 * views see the part (along -Z from the top, from the front for Y, from the right for X), so the
 * outline is not mirrored.
 */
export function sectionFrame(
  axis: SectionAxis,
  position: number,
): { frame: Frame; height: number } {
  switch (axis) {
    case 'z':
      return { frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, height: position };
    case 'y':
      // Normal -Y: the 2D axes are X and Z, as in the Front view.
      return {
        frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
        height: -position,
      };
    case 'x':
      // Normal +X: the 2D axes are Y and Z, as in the Right view.
      return { frame: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }, height: position };
  }
}

/** A kernel loop as a CAM loop: polylines become lines, arcs keep their turn. */
export function kernelLoop(loop: KernelLoop): Loop2 {
  const segments: Segment2[] = [];
  for (const s of loop.segments) {
    if (s.kind === 'line') segments.push({ kind: 'line', start: s.start, end: s.end });
    else if (s.kind === 'arc') {
      const full = Math.abs(Math.abs(s.sweep) - 2 * Math.PI) < 1e-9;
      segments.push({
        kind: 'arc',
        start: s.start,
        end: full ? s.start : s.end,
        center: s.center,
        ccw: s.sweep > 0,
        ...(full ? { fullCircle: true } : {}),
      });
    } else {
      for (let i = 0; i + 1 < s.points.length; i++)
        segments.push({ kind: 'line', start: s.points[i]!, end: s.points[i + 1]! });
    }
  }
  return { segments };
}

/** A section's closed loops on their plane, in model coordinates. */
export function sectionPlanar(section: SectionLoops, frame: Frame): PlanarLoops {
  const n = frame.normal;
  const h = section.height;
  return {
    origin: [frame.origin[0] + n[0] * h, frame.origin[1] + n[1] * h, frame.origin[2] + n[2] * h],
    xDir: frame.xDir,
    normal: frame.normal,
    loops: section.regions.flatMap((r) => [kernelLoop(r.outer), ...r.holes.map(kernelLoop)]),
  };
}

/** A body of the part, as the export dialog offers it. */
export interface LaserBody {
  /** The core body id. */
  readonly bodyId: string;
  /** Its viewport id (the kernel shape the scene holds). */
  readonly viewId: string;
  readonly name: string;
  /** Its bounds in model coordinates (from the mesh shown), for a section's default plane. */
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
}

/** The middle of a body along an axis, mm; zero when its bounds are not known. */
export function middleAlong(body: LaserBody | undefined, axis: SectionAxis): number {
  const b = body?.bounds;
  if (!b) return 0;
  const i = { x: 0, y: 1, z: 2 }[axis];
  return (b.min[i]! + b.max[i]!) / 2;
}

// ---------------------------------------------------------------------------------------------
// The geometry stage

const zero = (doc: ManufaktureDocument): StoredExpression => ({
  source: '0',
  ...bareUnits(doc.units),
});

/** An id of `prefix#n` that `taken` does not hold. */
function freeId(prefix: string, taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) if (!taken.has(`${prefix}#${i}`)) return `${prefix}#${i}`;
}

/**
 * `doc` with a setup added that the geometry stage resolves `sources` (faces and sketch regions)
 * for: never stored, only sent. Returns it with the setup's id.
 */
export function laserSetupDocument(
  doc: ManufaktureDocument,
  scope: Pick<LaserScope, 'partId' | 'body'>,
  sources: readonly Extract<LaserSource, { kind: 'face' | 'region' }>[],
  up: CamWcs['up'],
): { document: ManufaktureDocument; setupId: string } {
  const setupId = freeId('setup', new Set(doc.cam.setups.map((s) => s.id)));
  let r = 0;
  const geometry: CamGeometrySource[] = sources.map((s) =>
    s.kind === 'face'
      ? { kind: 'face', face: { id: `r${++r}`, ref: s.ref } }
      : { kind: 'region', sketch: s.sketch },
  );
  const z = zero(doc);
  // A tool id no tool has: the operation's numbers are never read, only its sources.
  const tool = freeId('tool', new Set(doc.cam.tools.map((t) => t.id)));
  const operation: CamOperation = {
    id: OPERATION_ID,
    kind: 'profile',
    name: 'Laser outline',
    suppressed: false,
    tool,
    geometry,
    side: 'on',
    depth: { kind: 'through' },
    entry: { kind: 'plunge' },
    leadIn: { kind: 'none' },
    leadOut: { kind: 'none' },
    climb: true,
  };
  const setup: CamSetup = {
    id: setupId,
    name: 'Laser export',
    part: scope.partId,
    ...(scope.body === undefined ? {} : { body: scope.body }),
    machine: 'laser',
    post: 'laser',
    stock: {
      kind: 'fromBody',
      margins: { xMin: z, xMax: z, yMin: z, yMax: z, top: z, bottom: z },
    },
    wcs: { up, origin: { xy: 'front-left', z: 'bottom' } },
    heights: { clearance: z, retract: z },
    operations: [operation],
  };
  return {
    document: { ...doc, cam: { ...doc.cam, setups: [...doc.cam.setups, setup] } },
    setupId,
  };
}

interface StageReply {
  /** Planar loops by index into the sources sent. */
  planar: Map<number, PlanarLoops>;
  errors: { source?: number; message: string; code: string }[];
  warnings: { source?: number; message: string }[];
}

function stageReply(result: CamGeometryResult): StageReply {
  const planar = new Map<number, PlanarLoops>();
  const errors: StageReply['errors'] = result.errors.map((e: CamStageError) => ({
    message: e.message,
    code: e.code,
  }));
  const warnings: StageReply['warnings'] = result.warnings
    .filter((w) => w.code !== 'source-errors')
    .map((w) => ({ message: w.message }));
  const op = result.operations.find((o) => o.operationId === OPERATION_ID);
  for (const s of op?.sources ?? []) {
    if ((s.kind === 'face' || s.kind === 'region') && typeof s.source === 'number')
      planar.set(s.source, s.planar);
  }
  for (const e of op?.errors ?? []) {
    // Only the sources' own errors: the made-up operation's tool and numbers are not used.
    if (e.source !== undefined) errors.push({ source: e.source, message: e.message, code: e.code });
  }
  for (const w of op?.warnings ?? []) {
    if (w.source !== undefined && w.code === 'reference')
      warnings.push({ source: w.source, message: w.message });
  }
  return { planar, errors, warnings };
}

async function askStage(
  geometer: CamGeometer,
  doc: ManufaktureDocument,
  scope: LaserScope,
  sources: readonly Extract<LaserSource, { kind: 'face' | 'region' }>[],
  up: CamWcs['up'],
): Promise<StageReply | null> {
  const { document, setupId } = laserSetupDocument(doc, scope, sources, up);
  const result = await geometer.geometry(document, setupId);
  return result === null ? null : stageReply(result);
}

const notParallel = (r: StageReply) => r.errors.filter((e) => e.code === 'not-parallel').length;

// ---------------------------------------------------------------------------------------------
// Extraction

/**
 * The loops of `sources` in one 2D frame, grouped into layers by name (in the order each name
 * first appears). Fails with every problem found, each naming its source.
 */
export async function extractLoops(
  doc: ManufaktureDocument,
  scope: LaserScope,
  sources: readonly LaserSource[],
  services: LaserServices,
): Promise<Extraction> {
  if (sources.length === 0)
    return { ok: false, messages: ['Add a face, a sketch region or a section to export.'] };
  const messages: string[] = [];
  const warnings: string[] = [];
  for (const s of sources)
    if (s.layer.trim() === '') messages.push(`${s.label}: give it a layer name.`);
  const planar = new Map<number, PlanarLoops>();

  // Faces and sketch regions, through the geometry stage.
  const staged = sources.flatMap((s, i) =>
    s.kind === 'face' || s.kind === 'region' ? [{ s, i }] : [],
  );
  if (staged.length > 0) {
    if (services.geometer === null) {
      messages.push('Faces and sketch regions need the geometry kernel.');
    } else {
      const list = staged.map((x) => x.s);
      const firstFace = list.find((s) => s.kind === 'face');
      let reply: StageReply | null = null;
      if (firstFace?.kind === 'face') {
        reply = await askStage(services.geometer, doc, scope, list, {
          kind: 'face',
          face: { id: 'r1', ref: firstFace.ref },
        });
      } else {
        // Sketch regions alone: the first model axis their sketches all lie across.
        for (const axis of REGION_AXES) {
          const r = await askStage(services.geometer, doc, scope, list, { kind: 'axis', axis });
          if (r === null) {
            reply = null;
            break;
          }
          if (reply === null || notParallel(r) < notParallel(reply)) reply = r;
          if (notParallel(r) === 0) break;
        }
      }
      if (reply === null) {
        messages.push('The model changed while the outlines were read: try again.');
      } else {
        const label = (k: number | undefined) =>
          k === undefined ? null : (staged[k]?.s.label ?? null);
        for (const e of reply.errors) {
          const l = label(e.source);
          messages.push(
            e.code === 'not-parallel' && l !== null
              ? `${l}: not parallel to the first face; export it on its own.`
              : l === null
                ? e.message
                : `${l}: ${e.message}`,
          );
        }
        for (const w of reply.warnings) {
          const l = label(w.source);
          warnings.push(l === null ? w.message : `${l}: ${w.message}`);
        }
        for (const [k, p] of reply.planar) planar.set(staged[k]!.i, p);
      }
    }
  }

  // Sections, through the kernel.
  for (const [i, s] of sources.entries()) {
    if (s.kind !== 'section') continue;
    if (!services.section) {
      messages.push(`${s.label}: sections need the geometry kernel.`);
      continue;
    }
    const { frame, height } = sectionFrame(s.axis, s.position);
    const r = await services.section(scope.viewId, frame, height, SECTION_DEFLECTION);
    if (!r.ok) {
      messages.push(`${s.label}: ${r.message}`);
      continue;
    }
    if (r.value.regions.length === 0) {
      messages.push(`${s.label}: the plane does not cut the body.`);
      continue;
    }
    if (r.value.open.length > 0)
      warnings.push(
        `${s.label}: ${r.value.open.length} open chain(s) left out (the body is not closed).`,
      );
    planar.set(i, sectionPlanar(r.value, frame));
  }

  if (messages.length > 0) return { ok: false, messages };

  // One frame: the first source's plane.
  const firstIndex = sources.findIndex((_, i) => planar.has(i));
  const first = planar.get(firstIndex);
  if (!first) return { ok: false, messages: ['Nothing to export.'] };
  const frame = planeFrame(first);
  const layers = new Map<string, Loop2[]>();
  for (const [i, s] of sources.entries()) {
    const p = planar.get(i);
    if (!p) continue;
    const m = planarLoopsToMachine(frame, p);
    if (!m.ok) {
      messages.push(
        m.error.code === 'not-parallel'
          ? `${s.label}: not parallel to ${sources[firstIndex]!.label}; export it on its own.`
          : `${s.label}: ${m.error.message}`,
      );
      continue;
    }
    const name = s.layer.trim();
    const into = layers.get(name) ?? [];
    into.push(...m.value.loops);
    layers.set(name, into);
  }
  if (messages.length > 0) return { ok: false, messages };
  const out = [...layers].map(([name, loops]) => ({ name, loops }));
  if (out.every((l) => l.loops.length === 0))
    return { ok: false, messages: ['The sources have no closed outline.'] };
  return { ok: true, layers: out, warnings };
}

/** A right-handed frame on a plane: its normal is Z, its X direction X. */
function planeFrame(p: PlanarLoops): WcsFrame {
  const unit = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const z = unit(p.normal);
  const d = p.xDir[0] * z[0] + p.xDir[1] * z[1] + p.xDir[2] * z[2];
  const x = unit([p.xDir[0] - d * z[0], p.xDir[1] - d * z[1], p.xDir[2] - d * z[2]]);
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { origin: p.origin, xAxis: x, yAxis: y, zAxis: z };
}

// ---------------------------------------------------------------------------------------------
// Size, kerf and the file

export interface OutlineSize {
  readonly min: Vec2;
  readonly width: number;
  readonly height: number;
}

/** The bounds of every loop of the layers (arcs by their extremes); null when there are none. */
export function outlineSize(layers: readonly LaserLayer[]): OutlineSize | null {
  const loops = layers.flatMap((l) => l.loops);
  if (loops.length === 0) return null;
  const b = sheetBounds(loopsToSheet([{ name: 'all', loops }]));
  return { min: b.min, width: b.max[0] - b.min[0], height: b.max[1] - b.min[1] };
}

/**
 * What is wrong with a kerf of `kerf` mm for an outline of `size`, or null: it must be zero or
 * more, at most `MAX_KERF`, and at most `MAX_KERF_FRACTION` of the outline's smaller side.
 */
export function kerfProblem(kerf: number, size: OutlineSize | null): string | null {
  if (!Number.isFinite(kerf)) return 'The kerf must be a finite number.';
  if (kerf < 0) return 'The kerf must be zero or more.';
  if (kerf > MAX_KERF)
    return `A kerf over ${MAX_KERF} mm is wider than any laser or plasma cut: check the value and its units.`;
  if (size) {
    const side = Math.min(size.width, size.height);
    const most = side * MAX_KERF_FRACTION;
    if (kerf > most)
      return `The kerf is too wide for this outline (${mm(size.width)} x ${mm(size.height)} mm): at most ${mm(most)} mm, a quarter of its smaller side.`;
  }
  return null;
}

const mm = (v: number) => String(Math.round(v * 1000) / 1000);

function shift(loop: Loop2, dx: number, dy: number): Loop2 {
  const p = (q: Vec2): Vec2 => [q[0] + dx, q[1] + dy];
  return {
    segments: loop.segments.map((s) =>
      s.kind === 'line'
        ? { ...s, start: p(s.start), end: p(s.end) }
        : { ...s, start: p(s.start), end: p(s.end), center: p(s.center) },
    ),
  };
}

/**
 * Warnings for layer names the file cannot keep apart: DXF names lose `<>/\":;?*|=`, backquote
 * and anything outside printable ASCII, and compare without case (the writer then numbers the
 * later one, `_2`); SVG ids keep only letters, digits, `_`, `.` and `-`.
 */
export function layerNameClashes(names: readonly string[], format: LaserFormat): string[] {
  const written = (n: string) => (format === 'dxf' ? dxfName(n).toUpperCase() : layerId(n));
  const byWritten = new Map<string, string[]>();
  for (const n of names) {
    const key = written(n);
    const list = byWritten.get(key) ?? [];
    if (!list.includes(n)) list.push(n);
    byWritten.set(key, list);
  }
  const out: string[] = [];
  if (format === 'dxf') {
    const zero = names.find((n) => written(n) === '0');
    if (zero !== undefined)
      out.push(
        `Layer "${zero}" is DXF's own default layer, so it is written as 0_2: rename it to keep it apart.`,
      );
  }
  for (const list of byWritten.values()) {
    if (list.length < 2) continue;
    const quoted = list.map((n) => `"${n}"`).join(', ');
    out.push(
      format === 'dxf'
        ? `Layers ${quoted} have the same name in DXF; all but the first are numbered (_2, _3...): rename them to tell them apart.`
        : `Layers ${quoted} have the same id in SVG; rename them to tell them apart.`,
    );
  }
  return out;
}

export type LaserFileResult =
  | { ok: true; file: ExportedFile; warnings: string[]; size: OutlineSize }
  | { ok: false; message: string };

/**
 * The file of `layers` in `format`, each layer compensated for `kerf` (mm; zero for none), the
 * drawing moved so its lower left corner is at (0, 0). Named `<baseName>.<format>`.
 */
export function laserFile(
  layers: readonly LaserLayer[],
  options: { format: LaserFormat; kerf: number; baseName: string; title?: string },
): LaserFileResult {
  const problem = kerfProblem(options.kerf, outlineSize(layers));
  if (problem !== null) return { ok: false, message: problem };
  const warnings = layerNameClashes(
    layers.map((l) => l.name),
    options.format,
  );
  const cut: LaserLayer[] = [];
  for (const layer of layers) {
    const r = kerfLoops(layer.loops, options.kerf);
    if (!r.ok) return { ok: false, message: `Layer ${layer.name}: ${r.error.message}` };
    if (r.value.lost > 0)
      warnings.push(
        `Layer ${layer.name}: ${r.value.lost} hole(s) narrower than the kerf closed up and are left out.`,
      );
    cut.push({ name: layer.name, loops: r.value.loops });
  }
  const size = outlineSize(cut);
  if (size === null) return { ok: false, message: 'Nothing is left to cut with this kerf.' };
  const moved = cut.map((l) => ({
    name: l.name,
    loops: l.loops.map((loop) => shift(loop, -size.min[0], -size.min[1])),
  }));
  const title = options.title ?? options.baseName;
  try {
    const text =
      options.format === 'dxf' ? loopsToDxf(moved, { title }) : loopsToSvg(moved, { title });
    return {
      ok: true,
      file: {
        name: fileName(options.baseName, options.format),
        bytes: new TextEncoder().encode(text),
        type: MIME[options.format],
      },
      warnings,
      size: { min: [0, 0], width: size.width, height: size.height },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
