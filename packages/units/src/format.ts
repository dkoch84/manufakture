import {
  MM_PER_INCH,
  fromMillimetres,
  fromRadians,
  type AngleUnit,
  type LengthUnit,
} from './units';

/**
 * Allowed denominators for fractional-inch display. 1 means whole inches. Any other value at
 * runtime falls back to 16.
 */
export type FractionDenominator = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128;

/** Decimal display in a single unit: `12.50 mm`, `1.500"`, `3.2500'`. */
export interface DecimalLengthFormat {
  readonly unit: LengthUnit;
  /** Digits after the decimal point. Defaults: mm 2, cm 3, m 4, in 3, ft 4. */
  readonly decimals?: number;
}

/**
 * Fractional imperial display rounded to the nearest `1/denominator` inch (default 16):
 * `'ft-in'` gives `3' 4-1/2"`, `'in-fraction'` gives `40-1/2"`.
 */
export interface FractionalLengthFormat {
  readonly unit: 'ft-in' | 'in-fraction';
  readonly denominator?: FractionDenominator;
}

export type LengthFormat = DecimalLengthFormat | FractionalLengthFormat;

export interface AngleFormat {
  /** Default `'deg'`. `'pitch'` writes a roof pitch: `6/12` in a slope field, `6:12` elsewhere. */
  readonly unit?: AngleUnit | 'pitch';
  /**
   * Digits after the decimal point. Defaults: deg 2, rad 4, pitch 2. For a pitch they apply to
   * the rise, and trailing zeros are dropped (`7.5/12`, `6/12`).
   */
  readonly decimals?: number;
  /** Run of a pitch, default 12. Must be positive and finite; anything else falls back to 12. */
  readonly run?: number;
  /**
   * Whether the field is a slope field (`EvaluateOptions.slope`). Pass the same value as to
   * evaluation, so the output parses back: `6/12` in a slope field, `6:12` elsewhere.
   */
  readonly slope?: boolean;
}

/** The angle unit a slope field shows by default: pitch under `ft-in` and `in-fraction`. */
export function slopeDisplayUnit(
  length: LengthFormat['unit'],
  angle: AngleUnit = 'deg',
): AngleUnit | 'pitch' {
  return length === 'ft-in' || length === 'in-fraction' ? 'pitch' : angle;
}

const DEFAULT_DECIMALS: Readonly<Record<LengthUnit, number>> = {
  mm: 2,
  cm: 3,
  m: 4,
  in: 3,
  ft: 4,
};

const SUFFIX: Readonly<Record<LengthUnit, string>> = {
  mm: ' mm',
  cm: ' cm',
  m: ' m',
  in: '"',
  ft: "'",
};

const DENOMINATORS: readonly number[] = [1, 2, 4, 8, 16, 32, 64, 128];
const DEFAULT_DENOMINATOR = 16;

function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 0;
  return Math.min(12, Math.max(0, Math.trunc(decimals)));
}

/**
 * Text for a value that cannot be formatted: `NaN`, `Infinity` or `-Infinity`, without a unit.
 * It deliberately does not parse back as a value.
 */
function nonFinite(value: number): string {
  return String(value);
}

/** Fixed-point text without a negative sign on values that round to zero. */
function fixed(value: number, decimals: number): string {
  const text = value.toFixed(clampDecimals(decimals));
  return /^-[0.]*$/.test(text) ? text.slice(1) : text;
}

/** Greatest common divisor of two non-negative safe integers; 1 for anything else. */
function gcd(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) return 1;
  while (b !== 0) [a, b] = [b, a % b];
  return a === 0 ? 1 : a;
}

/** `whole`, `n/d` or `whole-n/d`, with the fraction reduced. */
function mixedNumber(whole: number, numerator: number, denominator: number): string {
  if (numerator === 0) return String(whole);
  const g = gcd(numerator, denominator);
  const fraction = `${numerator / g}/${denominator / g}`;
  return whole === 0 ? fraction : `${whole}-${fraction}`;
}

function formatFractional(mm: number, format: FractionalLengthFormat): string {
  // Callers outside TypeScript can pass anything; fall back rather than loop or divide by zero.
  const requested = format.denominator ?? DEFAULT_DENOMINATOR;
  const denominator = DENOMINATORS.includes(requested) ? requested : DEFAULT_DENOMINATOR;
  // Round once, on the total, so carries (11-63/64" -> 1' 0") fall out of the integer split.
  const units = Math.round((Math.abs(mm) / MM_PER_INCH) * denominator);
  const sign = mm < 0 && units > 0 ? '-' : '';
  if (format.unit === 'in-fraction') {
    const whole = Math.floor(units / denominator);
    return `${sign}${mixedNumber(whole, units - whole * denominator, denominator)}"`;
  }
  const perFoot = 12 * denominator;
  const feet = Math.floor(units / perFoot);
  const rest = units - feet * perFoot;
  const inches = Math.floor(rest / denominator);
  const inchText = `${mixedNumber(inches, rest - inches * denominator, denominator)}"`;
  return feet === 0 ? `${sign}${inchText}` : `${sign}${feet}' ${inchText}`;
}

function isFractional(format: LengthFormat): format is FractionalLengthFormat {
  return format.unit === 'ft-in' || format.unit === 'in-fraction';
}

/**
 * Formats a length given in millimetres. The output always parses back with `parseLength` to
 * the displayed value. `NaN` and infinities give `'NaN'`, `'Infinity'` or `'-Infinity'`.
 */
export function formatLength(mm: number, format: LengthFormat = { unit: 'mm' }): string {
  if (!Number.isFinite(mm)) return nonFinite(mm);
  if (isFractional(format)) return formatFractional(mm, format);
  const decimals = format.decimals ?? DEFAULT_DECIMALS[format.unit];
  return fixed(fromMillimetres(mm, format.unit), decimals) + SUFFIX[format.unit];
}

/** Fixed-point text with trailing zeros (and a trailing point) dropped: `7.50` gives `7.5`. */
function trimmed(value: number, decimals: number): string {
  const text = fixed(value, decimals);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

const DEFAULT_RUN = 12;

/**
 * Steepest angle shown as a pitch, 89.9° (a rise of about 6875 over 12). Steeper, the rise grows
 * without bound (`10243668143750816/12` near 90°) and says nothing a reader can use.
 */
const PITCH_LIMIT_RAD = (89.9 * Math.PI) / 180;

/**
 * A pitch: `rise/run` in a slope field, `rise:run` elsewhere. Angles steeper than 89.9° either way
 * fall back to degrees.
 */
function formatPitch(rad: number, format: AngleFormat): string {
  if (Math.abs(rad) > PITCH_LIMIT_RAD) {
    return formatAngle(rad, { unit: 'deg' });
  }
  const requested = format.run ?? DEFAULT_RUN;
  const run = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_RUN;
  const decimals = format.decimals ?? 2;
  const rise = trimmed(Math.tan(rad) * run, decimals);
  return `${rise}${format.slope === true ? '/' : ':'}${trimmed(run, 12)}`;
}

/**
 * Formats an angle given in radians: `45.00°`, `0.7854 rad`, or a pitch (`6/12`, `6:12`). The
 * output parses back to the displayed value (a pitch under the same `slope` option). `NaN` and
 * infinities give `'NaN'`, `'Infinity'` or `'-Infinity'`.
 */
export function formatAngle(rad: number, format: AngleFormat = {}): string {
  if (!Number.isFinite(rad)) return nonFinite(rad);
  if (format.unit === 'pitch') return formatPitch(rad, format);
  const unit = format.unit ?? 'deg';
  const decimals = format.decimals ?? (unit === 'deg' ? 2 : 4);
  const text = fixed(fromRadians(rad, unit), decimals);
  return unit === 'deg' ? `${text}°` : `${text} rad`;
}

/**
 * Formats a plain number with fixed decimals (default 3), never as `-0`. `NaN` and infinities
 * give `'NaN'`, `'Infinity'` or `'-Infinity'`.
 */
export function formatNumber(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return nonFinite(value);
  return fixed(value, decimals);
}

/**
 * How to show a feed rate: the document's length format unit per minute. The fractional formats
 * show decimal inches per minute.
 */
export interface FeedFormat {
  /** Default `'mm'`. */
  readonly unit?: LengthFormat['unit'];
  /** Digits after the decimal point. Defaults: mm 0, cm 1, m 3, in 1, ft 2. */
  readonly decimals?: number;
}

const FEED_DECIMALS: Readonly<Record<LengthUnit, number>> = {
  mm: 0,
  cm: 1,
  m: 3,
  in: 1,
  ft: 2,
};

/**
 * Formats a feed rate given in mm/min: `1000 mm/min`, `39.4 in/min`. The output always parses
 * back with `parseFeed` to the displayed value. `NaN` and infinities give `'NaN'`, `'Infinity'`
 * or `'-Infinity'`.
 */
export function formatFeed(mmPerMinute: number, format: FeedFormat = {}): string {
  if (!Number.isFinite(mmPerMinute)) return nonFinite(mmPerMinute);
  const requested = format.unit ?? 'mm';
  const unit: LengthUnit = requested === 'ft-in' || requested === 'in-fraction' ? 'in' : requested;
  const decimals = format.decimals ?? FEED_DECIMALS[unit];
  return `${fixed(fromMillimetres(mmPerMinute, unit), decimals)} ${unit}/min`;
}

/**
 * Formats a spindle speed given in rpm with fixed decimals (default 0): `18000 rpm`. The output
 * always parses back with `parseSpindleSpeed`. `NaN` and infinities give `'NaN'`, `'Infinity'`
 * or `'-Infinity'`.
 */
export function formatSpindleSpeed(rpm: number, decimals = 0): string {
  if (!Number.isFinite(rpm)) return nonFinite(rpm);
  return `${fixed(rpm, decimals)} rpm`;
}
