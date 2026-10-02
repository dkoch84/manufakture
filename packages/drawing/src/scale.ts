// Drawing scales. A scale says how many paper millimetres stand for how many model millimetres:
// `1:5` is { paper: 1, model: 5 }, `1-1/2" = 1'` is { paper: 38.1, model: 304.8 }. The factor
// (paper per model millimetre) is what the view transform uses.

import { MM_PER_FOOT, MM_PER_INCH, formatLength, parseLength } from '@manufakture/units';

export interface Scale {
  /** Paper length, millimetres (or any unit shared with `model`). */
  readonly paper: number;
  /** The model length it stands for, same unit as `paper`. */
  readonly model: number;
  /** How to write it: `'ratio'` (`1:5`, the default) or `'imperial'` (`1-1/2" = 1'`). */
  readonly notation?: 'ratio' | 'imperial';
}

export const FULL_SIZE: Scale = { paper: 1, model: 1 };

const ratio = (paper: number, model: number): Scale => ({ paper, model });
const imperial = (paperInches: number): Scale => ({
  paper: paperInches * MM_PER_INCH,
  model: MM_PER_FOOT,
  notation: 'imperial',
});

/**
 * Metric scales: the ISO 5455 series as it is usually quoted (1, 2, 5 times powers of ten,
 * enlarging and reducing; the standard was not read, unverified).
 */
export const METRIC_SCALES: readonly Scale[] = [
  ratio(10, 1),
  ratio(5, 1),
  ratio(2, 1),
  ratio(1, 1),
  ratio(1, 2),
  ratio(1, 5),
  ratio(1, 10),
  ratio(1, 20),
  ratio(1, 50),
  ratio(1, 100),
  ratio(1, 200),
  ratio(1, 500),
  ratio(1, 1000),
];

/** Architectural scales, inches on paper per foot of model, from 3" = 1' down to 1/16" = 1'. */
export const IMPERIAL_SCALES: readonly Scale[] = [
  3, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.09375, 0.0625,
].map(imperial);

/** Paper millimetres per model millimetre. */
export function scaleFactor(scale: Scale): number {
  return scale.paper / scale.model;
}

export function modelToPaper(modelLength: number, scale: Scale): number {
  return modelLength * scaleFactor(scale);
}

export function paperToModel(paperLength: number, scale: Scale): number {
  return paperLength / scaleFactor(scale);
}

function trimNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** `1:5`, `2:1`, or `1-1/2" = 1'` (`3/4" = 1'`, `1/16" = 1'`, `1" = 10'`). */
export function formatScale(scale: Scale): string {
  if (scale.notation === 'imperial') {
    const paper = formatLength(scale.paper, { unit: 'in-fraction', denominator: 128 });
    const feet = scale.model / MM_PER_FOOT;
    const model =
      Math.abs(feet - Math.round(feet)) < 1e-9 && feet >= 1
        ? `${Math.round(feet)}'`
        : formatLength(scale.model, { unit: 'ft-in', denominator: 128 });
    return `${paper} = ${model}`;
  }
  return `${trimNumber(scale.paper)}:${trimNumber(scale.model)}`;
}

export type ScaleParse = { ok: true; scale: Scale } | { ok: false; message: string };

/** Unit words that keep a `paper = model` side imperial; any other word (`mm`, `m`) does not. */
const IMPERIAL_WORDS = new Set(['in', 'inch', 'inches', 'ft', 'foot', 'feet', 'yd']);

/** Whether a side of `paper = model` is in inches and feet: `"`, `'`, imperial words, bare numbers. */
function isImperialSide(text: string): boolean {
  return (text.match(/[a-z]+/gi) ?? []).every((w) => IMPERIAL_WORDS.has(w.toLowerCase()));
}

/** A ratio with its smaller side 1: `10 mm = 1 m` is 1:100. */
function reducedRatio(paper: number, model: number): Scale {
  return paper <= model ? { paper: 1, model: model / paper } : { paper: paper / model, model: 1 };
}

/**
 * Reads `1:5` or `2:1` (ratios), or `paper = model` with lengths `packages/units` reads
 * (`1-1/2" = 1'`, `3/4" = 1'-0"`, `10 mm = 1 m`); bare numbers there are inches. A `paper =
 * model` scale keeps imperial notation only when both sides are in inches and feet; otherwise
 * it becomes the ratio with its smaller side 1 (`10 mm = 1 m` is 1:100).
 */
export function parseScale(text: string): ScaleParse {
  const r = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (r) {
    const paper = Number(r[1]);
    const model = Number(r[2]);
    if (paper > 0 && model > 0) return { ok: true, scale: { paper, model } };
    return { ok: false, message: 'both sides of a scale must be positive' };
  }
  const sides = text.split('=');
  if (sides.length !== 2) return { ok: false, message: 'expected `a:b` or `paper = model`' };
  const paper = parseLength(sides[0]!.trim(), 'in');
  const model = parseLength(sides[1]!.trim(), 'in');
  if (!paper.ok) return { ok: false, message: `paper side: ${paper.error.message}` };
  if (!model.ok) return { ok: false, message: `model side: ${model.error.message}` };
  if (!(paper.value > 0 && model.value > 0))
    return { ok: false, message: 'both sides of a scale must be positive' };
  if (!isImperialSide(sides[0]!) || !isImperialSide(sides[1]!))
    return { ok: true, scale: reducedRatio(paper.value, model.value) };
  return { ok: true, scale: { paper: paper.value, model: model.value, notation: 'imperial' } };
}

/**
 * The largest scale among `candidates` at which a model extent (model millimetres) fits a paper
 * space (paper millimetres); the smallest candidate when none fits.
 */
export function chooseScale(
  extent: { readonly width: number; readonly height: number },
  space: { readonly width: number; readonly height: number },
  candidates: readonly Scale[] = METRIC_SCALES,
): Scale {
  const sorted = [...candidates].sort((a, b) => scaleFactor(b) - scaleFactor(a));
  for (const s of sorted) {
    const f = scaleFactor(s);
    if (extent.width * f <= space.width && extent.height * f <= space.height) return s;
  }
  return sorted[sorted.length - 1] ?? FULL_SIZE;
}
