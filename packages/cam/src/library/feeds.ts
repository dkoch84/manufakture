// Feed categories, the map from core's material ids to them, the chip load calculator and preset
// resolution (T5.1d). Presets are starting points, not promises: feeds tables disagree between
// sources, and stock, machine rigidity and tool wear all move the right numbers.

import { err, ok, type CamResult } from '../types';
import type {
  FeedCategory,
  LibraryPreset,
  LibraryTool,
  LibraryUnit,
  PresetVerified,
} from './types';

const IN = 25.4;

/** Millimetres in one `unit`. */
export function unitScale(unit: LibraryUnit): number {
  return unit === 'in' ? IN : 1;
}

/** A length (or a feed per minute) in `unit`, in millimetres (per minute). */
export function toMm(value: number, unit: LibraryUnit): number {
  return value * unitScale(unit);
}

/**
 * The feed categories presets are written for, in display order. Ids are permanent: documents
 * store them (a stock's `material`, a preset's `material`).
 */
export const FEED_CATEGORIES: readonly FeedCategory[] = [
  { id: 'plywood', name: 'Plywood' },
  { id: 'mdf', name: 'MDF' },
  { id: 'softwood', name: 'Softwood' },
  { id: 'hardwood', name: 'Hardwood' },
  { id: 'plastics', name: 'Plastics' },
  {
    id: 'aluminium',
    name: 'Aluminium',
    warning: 'Cut slowly with good chip clearing; the maker says it cuts slower than wood.',
  },
  {
    id: 'steel',
    name: 'Steel',
    warning:
      'Not recommended on a Shapeoko ("harder metals, like steel or stainless steel, are not recommended", https://shop.carbide3d.com/products/shapeoko4); the chart says to use coolant.',
  },
];

/**
 * The feed category each of core's material ids (`MATERIALS`) is cut as. Keyed by string so this
 * package does not load core; `apps/web`'s tests check every core material id is here.
 */
export const MATERIAL_FEED_CATEGORY: Readonly<Record<string, string>> = {
  pla: 'plastics',
  petg: 'plastics',
  abs: 'plastics',
  pine: 'softwood',
  oak: 'hardwood',
  plywood: 'plywood',
  mdf: 'mdf',
  'aluminium-6061': 'aluminium',
  steel: 'steel',
};

export function findFeedCategory(id: string): FeedCategory | undefined {
  return FEED_CATEGORIES.find((c) => c.id === id);
}

/**
 * The feed category for `material`: a feed category id itself, or one of core's material ids;
 * undefined for anything else.
 */
export function feedCategoryOf(material: string): string | undefined {
  if (findFeedCategory(material)) return material;
  return Object.hasOwn(MATERIAL_FEED_CATEGORY, material)
    ? MATERIAL_FEED_CATEGORY[material]
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Chip load

function positive(name: string, v: number): CamResult<number> | undefined {
  return Number.isFinite(v) && v > 0
    ? undefined
    : err('invalid-input', `${name} must be a finite number greater than zero, got ${v}`);
}

/**
 * The feed for a chip load: `feed = rpm x flutes x chipLoad`. `chipLoad` is the thickness each
 * flute takes per revolution, in a length unit; the feed comes back in that unit per minute.
 */
export function feedFromChipLoad(rpm: number, flutes: number, chipLoad: number): CamResult<number> {
  const bad = positive('rpm', rpm) ?? positive('flutes', flutes) ?? positive('chip load', chipLoad);
  if (bad) return bad;
  if (!Number.isInteger(flutes)) return err('invalid-input', `flutes must be whole, got ${flutes}`);
  return ok(rpm * flutes * chipLoad);
}

/** The chip load of a feed: `chipLoad = feed / (rpm x flutes)`, in the feed's length unit. */
export function chipLoadFromFeed(feed: number, rpm: number, flutes: number): CamResult<number> {
  const bad = positive('feed', feed) ?? positive('rpm', rpm) ?? positive('flutes', flutes);
  if (bad) return bad;
  if (!Number.isInteger(flutes)) return err('invalid-input', `flutes must be whole, got ${flutes}`);
  return ok(feed / (rpm * flutes));
}

// ---------------------------------------------------------------------------------------------
// Resolution

/** A preset in internal units, ready for an operation: mm, mm/min, rpm. */
export interface ResolvedPreset {
  /** The feed category the material resolved to. */
  readonly category: string;
  readonly rpm: number;
  /** mm/min. */
  readonly feed: number;
  /** mm/min. */
  readonly plunge: number;
  /** mm. */
  readonly stepdown: number;
  /** Fraction of the tool diameter. */
  readonly stepover: number;
  /** mm per flute per revolution, from the feed. */
  readonly chipLoad: number;
  readonly source: string;
  readonly verified: PresetVerified;
  /** True when every number was read from its source. */
  readonly allVerified: boolean;
  /** The category's caution, when it has one. */
  readonly warning?: string;
  readonly note?: string;
}

/**
 * The preset of `tool` for `material` (a feed category id, or one of core's material ids), in
 * internal units. Fails when the material is unknown or the tool has no preset for its category.
 */
export function resolvePreset(tool: LibraryTool, material: string): CamResult<ResolvedPreset> {
  const category = feedCategoryOf(material);
  if (category === undefined) {
    return err('invalid-input', `"${material}" is neither a feed category nor a known material`);
  }
  const preset = tool.presets.find((p) => p.category === category);
  if (!preset) {
    return err('invalid-input', `Tool ${tool.id} has no feed preset for ${category}`);
  }
  return ok(resolved(tool, preset));
}

function resolved(tool: LibraryTool, p: LibraryPreset): ResolvedPreset {
  const feed = toMm(p.feed, p.unit);
  const warning = findFeedCategory(p.category)?.warning;
  return {
    category: p.category,
    rpm: p.rpm,
    feed,
    plunge: toMm(p.plunge, p.unit),
    stepdown: toMm(p.stepdown, p.unit),
    stepover: p.stepover,
    chipLoad: feed / (p.rpm * tool.flutes),
    source: p.source,
    verified: p.verified,
    allVerified: p.verified.feeds && p.verified.stepdown && p.verified.stepover,
    ...(warning === undefined ? {} : { warning }),
    ...(p.note === undefined ? {} : { note: p.note }),
  };
}

/**
 * The preset among `presets` (a document tool's, whose `material` is a feed category) for
 * `material`: a feed category or a core material id.
 */
export function findPresetFor<P extends { readonly material: string }>(
  presets: readonly P[],
  material: string,
): P | undefined {
  const category = feedCategoryOf(material);
  return category === undefined ? undefined : presets.find((p) => p.material === category);
}
