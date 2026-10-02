// One-dimensional cutting: lengths cut from stock lengths of lumber (a cutting stock problem).
// First-fit decreasing plus best-fit and worst-fit variants, several stock orders and seeded
// perturbations, keeping the best; then each stick is moved to the shortest stock that still
// holds its cuts.
//
// A stick's coordinate runs from 0 at one end of the stock to the stock's length. The start
// trim is cut off first; pieces follow in order, each separated from the next by the kerf.

import {
  EPS,
  compareScores,
  isNonNegativeFinite,
  isPositiveFinite,
  isQuantity,
  perturb,
  seededRandom,
  yieldToEventLoop,
  type Progress,
  type Unplaced,
  type UnplacedReason,
} from './common';

export interface StickPart {
  id: string;
  length: number;
  quantity: number;
}

export interface StickStock {
  id: string;
  length: number;
  /** Absent means unlimited. */
  quantity?: number;
  /** Price per stick. Used for ranking only when every stock has one. */
  cost?: number;
}

export interface StickSettings {
  kerf: number;
  /**
   * Material cut off each end before pieces are cut (checked or split ends), measured from the
   * end to the usable length; the kerf of a trim cut falls inside the trim. One number for both
   * ends, or per end. Default 0.
   */
  trims?: number | { start?: number; end?: number };
  /** A leftover at least this long is an offcut (reusable); shorter is waste. Default 0. */
  minOffcut?: number;
  /** Default 1. */
  seed?: number;
  /** Extra attempts that perturb the best rule's order. Default 30. */
  randomAttempts?: number;
}

export interface StickInput {
  parts: readonly StickPart[];
  stock: readonly StickStock[];
  settings: StickSettings;
}

export interface StickCut {
  partId: string;
  /** Which copy of the part, from 1. */
  copy: number;
  /** Where the piece starts on the stick. */
  start: number;
  length: number;
}

export interface StickLayout {
  index: number;
  stockId: string;
  length: number;
  /** The usable length after trims: [usableStart, usableEnd]. */
  usableStart: number;
  usableEnd: number;
  /** In order along the stick. */
  cuts: StickCut[];
  /** What is left after the last piece and its kerf, when it is at least `minOffcut`. */
  offcut: { start: number; length: number } | null;
  partsLength: number;
  offcutLength: number;
  /** Parts length over stock length. */
  utilisation: number;
  /** Length that is neither part nor offcut (trims, kerf, short leftover), as a percentage. */
  wastePercent: number;
}

export type StickSortRule = 'length' | 'input';
export type FitRule = 'first-fit' | 'best-fit' | 'worst-fit';
export type StickStockOrder = 'longest-first' | 'shortest-that-fits' | 'input';

export interface StickRule {
  sort: StickSortRule;
  fit: FitRule;
  stockOrder: StickStockOrder;
  /** 0 for the rule grid, n for the n-th perturbation of the best rule's order. */
  perturbation: number;
}

export interface StickLayoutResult {
  sticks: StickLayout[];
  unplaced: Unplaced[];
  stock: { stockId: string; count: number; cost?: number }[];
  totals: {
    sticks: number;
    stockLength: number;
    partsLength: number;
    offcutLength: number;
    utilisation: number;
    wastePercent: number;
    /** Present when every stock used has a cost. */
    cost?: number;
  };
  rule: StickRule;
  attempts: number;
}

export const STICK_SORT_RULES: readonly StickSortRule[] = ['length', 'input'];
export const FIT_RULES: readonly FitRule[] = ['first-fit', 'best-fit', 'worst-fit'];
export const STICK_STOCK_ORDERS: readonly StickStockOrder[] = [
  'longest-first',
  'shortest-that-fits',
  'input',
];

interface Settings {
  kerf: number;
  start: number;
  end: number;
  minOffcut: number;
  seed: number;
  randomAttempts: number;
}

interface Stock extends StickStock {
  index: number;
  usable: number;
}

interface Instance {
  part: StickPart;
  copy: number;
  order: number;
}

interface OpenStick {
  stock: Stock;
  pieces: Instance[];
  /** Where the next piece would start. */
  next: number;
}

/** Resolves the trims setting to start and end trims. */
export function resolveStickTrims(trims: StickSettings['trims']): { start: number; end: number } {
  if (trims === undefined) return { start: 0, end: 0 };
  if (typeof trims === 'number') return { start: trims, end: trims };
  return { start: trims.start ?? 0, end: trims.end ?? 0 };
}

function normalise(input: StickInput): { settings: Settings; stock: Stock[] } {
  const s = input.settings;
  if (!isNonNegativeFinite(s.kerf)) throw new RangeError(`kerf must be >= 0, got ${s.kerf}`);
  const { start, end } = resolveStickTrims(s.trims);
  if (!isNonNegativeFinite(start) || !isNonNegativeFinite(end)) {
    throw new RangeError('trims must be >= 0');
  }
  const minOffcut = s.minOffcut ?? 0;
  if (!isNonNegativeFinite(minOffcut)) throw new RangeError('minOffcut must be >= 0');
  const randomAttempts = s.randomAttempts ?? 30;
  if (!isQuantity(randomAttempts)) throw new RangeError('randomAttempts must be an integer >= 0');
  const seed = s.seed ?? 1;
  if (!Number.isInteger(seed)) throw new RangeError('seed must be an integer');
  const ids = new Set<string>();
  const stock = input.stock.map((st, index) => {
    if (ids.has(st.id)) throw new RangeError(`duplicate stock id ${st.id}`);
    ids.add(st.id);
    if (!isPositiveFinite(st.length)) throw new RangeError(`stock ${st.id}: length must be > 0`);
    if (st.quantity !== undefined && !isQuantity(st.quantity)) {
      throw new RangeError(`stock ${st.id}: quantity must be an integer >= 0`);
    }
    if (st.cost !== undefined && !isNonNegativeFinite(st.cost)) {
      throw new RangeError(`stock ${st.id}: cost must be >= 0`);
    }
    const usable = st.length - start - end;
    if (usable <= EPS) throw new RangeError(`stock ${st.id}: the trims leave no usable length`);
    return { ...st, index, usable };
  });
  return { settings: { kerf: s.kerf, start, end, minOffcut, seed, randomAttempts }, stock };
}

/** Length the pieces take on a stick, kerfs between them included (the last kerf excluded). */
function contentLength(pieces: readonly Instance[], kerf: number): number {
  if (pieces.length === 0) return 0;
  return pieces.reduce((a, p) => a + p.part.length, 0) + (pieces.length - 1) * kerf;
}

interface Attempt {
  sticks: OpenStick[];
  unplaced: Instance[];
  score: number[];
}

function runAttempt(
  instances: readonly Instance[],
  fit: FitRule,
  stockOrder: StickStockOrder,
  stock: readonly Stock[],
  settings: Settings,
  allPriced: boolean,
): Attempt {
  const sticks: OpenStick[] = [];
  const used = new Map<string, number>();
  const left = (s: Stock) => s.quantity === undefined || (used.get(s.id) ?? 0) < s.quantity;
  const unplaced: Instance[] = [];
  const ordered =
    stockOrder === 'input'
      ? [...stock]
      : [...stock].sort((a, b) =>
          stockOrder === 'longest-first'
            ? b.length - a.length || a.index - b.index
            : a.length - b.length || a.index - b.index,
        );

  for (const inst of instances) {
    const len = inst.part.length;
    let chosen: OpenStick | null = null;
    let chosenRest = 0;
    for (const stick of sticks) {
      const rest = settings.start + stick.stock.usable - (stick.next + len);
      if (rest < -EPS) continue;
      if (fit === 'first-fit') {
        chosen = stick;
        break;
      }
      const better = fit === 'best-fit' ? rest < chosenRest - EPS : rest > chosenRest + EPS;
      if (!chosen || better) {
        chosen = stick;
        chosenRest = rest;
      }
    }
    if (!chosen) {
      const stockFor = ordered.find((s) => left(s) && s.usable >= len - EPS);
      if (stockFor) {
        chosen = { stock: stockFor, pieces: [], next: settings.start };
        sticks.push(chosen);
        used.set(stockFor.id, (used.get(stockFor.id) ?? 0) + 1);
      }
    }
    if (!chosen) {
      unplaced.push(inst);
      continue;
    }
    chosen.pieces.push(inst);
    chosen.next += len + settings.kerf;
  }

  // Move each stick to the shortest stock left that holds its pieces.
  for (const stick of sticks) {
    const need = contentLength(stick.pieces, settings.kerf);
    const options = stock
      .filter((s) => s === stick.stock || (left(s) && s.usable >= need - EPS))
      .sort((a, b) => a.length - b.length || a.index - b.index);
    const shortest = options[0]!;
    if (shortest !== stick.stock && shortest.length < stick.stock.length - EPS) {
      used.set(stick.stock.id, (used.get(stick.stock.id) ?? 0) - 1);
      used.set(shortest.id, (used.get(shortest.id) ?? 0) + 1);
      stick.stock = shortest;
    }
  }

  let cost = 0;
  let length = 0;
  let quality = 0;
  for (const stick of sticks) {
    cost += stick.stock.cost ?? 0;
    length += stick.stock.length;
    const rest = offcutOf(stick, settings);
    if (rest !== null) quality += (rest.length / stick.stock.length) ** 2;
  }
  return {
    sticks,
    unplaced,
    score: [unplaced.length, allPriced ? cost : 0, length, sticks.length, -quality],
  };
}

function offcutOf(stick: OpenStick, settings: Settings): { start: number; length: number } | null {
  const end = settings.start + stick.stock.usable;
  const start = stick.next;
  const length = end - start;
  if (length <= EPS || length < settings.minOffcut - EPS) return null;
  return { start, length };
}

/**
 * Lays out the cut lengths, one attempt per step; see `layoutSheetsSteps` for the protocol.
 * Throws RangeError on invalid stock or settings, or a duplicate part id.
 */
export function* layoutSticksSteps(
  input: StickInput,
): Generator<Progress, StickLayoutResult, void> {
  const { settings, stock } = normalise(input);
  const allPriced = stock.length > 0 && stock.every((s) => s.cost !== undefined);
  const instances: Instance[] = [];
  const invalid: Unplaced[] = [];
  const ids = new Set<string>();
  for (const part of input.parts) {
    if (ids.has(part.id)) throw new RangeError(`duplicate part id ${part.id}`);
    ids.add(part.id);
    if (!isQuantity(part.quantity)) {
      throw new RangeError(`part ${part.id}: quantity must be an integer >= 0`);
    }
    if (part.quantity === 0) continue;
    if (!isPositiveFinite(part.length)) {
      invalid.push({ partId: part.id, quantity: part.quantity, reason: 'invalid' });
      continue;
    }
    for (let copy = 1; copy <= part.quantity; copy++) {
      instances.push({ part, copy, order: instances.length });
    }
  }

  const sorts: Record<StickSortRule, Instance[]> = {
    length: [...instances].sort((a, b) => b.part.length - a.part.length || a.order - b.order),
    input: instances,
  };
  const stockOrders = stock.length > 1 ? STICK_STOCK_ORDERS : (['input'] as const);
  const grid: StickRule[] = [];
  for (const sort of STICK_SORT_RULES) {
    for (const fit of FIT_RULES) {
      for (const stockOrder of stockOrders) grid.push({ sort, fit, stockOrder, perturbation: 0 });
    }
  }
  // The random attempts only run when there is more than one copy to reorder.
  const total = grid.length + (instances.length > 1 ? settings.randomAttempts : 0);
  let best: { attempt: Attempt; rule: StickRule; order: Instance[] } | null = null;
  let done = 0;
  for (const rule of grid) {
    const order = sorts[rule.sort];
    const attempt = runAttempt(order, rule.fit, rule.stockOrder, stock, settings, allPriced);
    if (!best || compareScores(attempt.score, best.attempt.score) < 0) {
      best = { attempt, rule, order };
    }
    done++;
    yield { attempt: done, total };
  }
  if (best && instances.length > 1) {
    const random = seededRandom(settings.seed);
    const base = best;
    for (let n = 1; n <= settings.randomAttempts; n++) {
      const order = perturb(base.order, random);
      const attempt = runAttempt(
        order,
        base.rule.fit,
        base.rule.stockOrder,
        stock,
        settings,
        allPriced,
      );
      if (compareScores(attempt.score, best.attempt.score) < 0) {
        best = { attempt, rule: { ...base.rule, perturbation: n }, order };
      }
      done++;
      yield { attempt: done, total };
    }
  }
  const chosen = best ?? {
    attempt: { sticks: [], unplaced: [], score: [] },
    rule: { sort: 'length', fit: 'first-fit', stockOrder: 'input', perturbation: 0 } as StickRule,
  };
  return buildResult(chosen.attempt, invalid, stock, settings, chosen.rule, done);
}

function buildResult(
  attempt: Attempt,
  invalid: Unplaced[],
  stock: readonly Stock[],
  settings: Settings,
  rule: StickRule,
  attempts: number,
): StickLayoutResult {
  const sticks: StickLayout[] = attempt.sticks.map((s, index) => {
    const cuts: StickCut[] = [];
    let at = settings.start;
    for (const p of s.pieces) {
      cuts.push({ partId: p.part.id, copy: p.copy, start: at, length: p.part.length });
      at += p.part.length + settings.kerf;
    }
    const offcut = offcutOf(s, settings);
    const partsLength = cuts.reduce((a, c) => a + c.length, 0);
    const offcutLength = offcut?.length ?? 0;
    return {
      index,
      stockId: s.stock.id,
      length: s.stock.length,
      usableStart: settings.start,
      usableEnd: settings.start + s.stock.usable,
      cuts,
      offcut,
      partsLength,
      offcutLength,
      utilisation: partsLength / s.stock.length,
      wastePercent: (100 * (s.stock.length - partsLength - offcutLength)) / s.stock.length,
    };
  });

  const unplaced: Unplaced[] = [...invalid];
  const byPart = new Map<string, { quantity: number; reason: UnplacedReason }>();
  for (const inst of attempt.unplaced) {
    const entry = byPart.get(inst.part.id);
    if (entry) {
      entry.quantity++;
    } else {
      const fitsSome = stock.some((s) => s.usable >= inst.part.length - EPS);
      byPart.set(inst.part.id, { quantity: 1, reason: fitsSome ? 'out-of-stock' : 'does-not-fit' });
    }
  }
  for (const [partId, e] of byPart) unplaced.push({ partId, ...e });

  const usage: StickLayoutResult['stock'] = [];
  for (const s of stock) {
    const count = sticks.filter((st) => st.stockId === s.id).length;
    if (count === 0) continue;
    usage.push(
      s.cost === undefined
        ? { stockId: s.id, count }
        : { stockId: s.id, count, cost: s.cost * count },
    );
  }
  const stockLength = sticks.reduce((a, s) => a + s.length, 0);
  const partsLength = sticks.reduce((a, s) => a + s.partsLength, 0);
  const offcutLength = sticks.reduce((a, s) => a + s.offcutLength, 0);
  const totals: StickLayoutResult['totals'] = {
    sticks: sticks.length,
    stockLength,
    partsLength,
    offcutLength,
    utilisation: stockLength > 0 ? partsLength / stockLength : 0,
    wastePercent:
      stockLength > 0 ? (100 * (stockLength - partsLength - offcutLength)) / stockLength : 0,
  };
  if (usage.every((u) => u.cost !== undefined)) {
    totals.cost = usage.reduce((a, u) => a + (u.cost ?? 0), 0);
  }
  return { sticks, unplaced, stock: usage, totals, rule, attempts };
}

/** Lays out cut lengths on stock lengths. Synchronous; see `layoutSticksSteps`. */
export function layoutSticks(input: StickInput): StickLayoutResult {
  const steps = layoutSticksSteps(input);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Like `layoutSticks`, yielding between attempts; rejects with `signal.reason` on abort. */
export async function layoutSticksAsync(
  input: StickInput,
  options: { signal?: AbortSignal } = {},
): Promise<StickLayoutResult> {
  const steps = layoutSticksSteps(input);
  for (;;) {
    options.signal?.throwIfAborted();
    const r = steps.next();
    if (r.done) return r.value;
    await yieldToEventLoop();
  }
}

/**
 * Checks a stick layout against its input; returns the problems found, empty when valid:
 * stick lengths match their stock, stock quantities hold, every piece lies in the usable
 * length with at least the kerf between neighbours, and placed plus unplaced copies of each
 * part equal its quantity.
 */
export function checkStickLayout(input: StickInput, result: StickLayoutResult): string[] {
  const problems: string[] = [];
  const kerf = input.settings.kerf;
  const { start, end } = resolveStickTrims(input.settings.trims);
  const parts = new Map(input.parts.map((p) => [p.id, p]));
  const stock = new Map(input.stock.map((s) => [s.id, s]));
  const copies = new Map<string, Set<number>>();
  const counts = new Map<string, number>();
  for (const stick of result.sticks) {
    const where = `stick ${stick.index}`;
    const s = stock.get(stick.stockId);
    if (!s) {
      problems.push(`${where}: unknown stock ${stick.stockId}`);
      continue;
    }
    counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    if (Math.abs(stick.length - s.length) > EPS) problems.push(`${where}: length differs`);
    const lo = start;
    const hi = s.length - end;
    let prevEnd = -Infinity;
    for (const c of stick.cuts) {
      const part = parts.get(c.partId);
      if (!part) {
        problems.push(`${where}: unknown part ${c.partId}`);
        continue;
      }
      if (Math.abs(c.length - part.length) > EPS) {
        problems.push(`${where}: ${c.partId} cut ${c.length}, part is ${part.length}`);
      }
      if (c.start < lo - EPS || c.start + c.length > hi + EPS) {
        problems.push(`${where}: ${c.partId} at ${c.start} is outside [${lo}, ${hi}]`);
      }
      if (c.start < prevEnd + kerf - EPS) {
        problems.push(`${where}: ${c.partId} at ${c.start} is closer than the kerf`);
      }
      prevEnd = c.start + c.length;
      if (!(Number.isInteger(c.copy) && c.copy >= 1 && c.copy <= part.quantity)) {
        problems.push(`${where}: ${c.partId} has copy ${c.copy} of ${part.quantity}`);
      }
      const set = copies.get(c.partId) ?? new Set<number>();
      if (set.has(c.copy)) problems.push(`${where}: ${c.partId} copy ${c.copy} cut twice`);
      set.add(c.copy);
      copies.set(c.partId, set);
    }
  }
  for (const [id, n] of counts) {
    const q = stock.get(id)?.quantity;
    if (q !== undefined && n > q) problems.push(`stock ${id}: ${n} sticks used of ${q}`);
  }
  const unplaced = new Map<string, number>();
  for (const u of result.unplaced)
    unplaced.set(u.partId, (unplaced.get(u.partId) ?? 0) + u.quantity);
  for (const part of input.parts) {
    const placed = copies.get(part.id)?.size ?? 0;
    const missing = unplaced.get(part.id) ?? 0;
    if (placed + missing !== part.quantity) {
      problems.push(
        `part ${part.id}: ${placed} cut + ${missing} unplaced, quantity ${part.quantity}`,
      );
    }
  }
  return problems;
}
