// Guillotine sheet layout: rectangular parts on rectangular stock sheets, every layout cut by a
// sequence of straight through cuts (Jylanki, "A Thousand Ways to Pack the Bin", 2010: the
// guillotine packer with free-rectangle choice and split rules). Kerf, trims, grain locks and
// a stage limit are built into the split step, so every layout this file returns is cuttable
// by construction; `checkSheetLayout` (sheet-check.ts) proves it by replaying the cut tree.
//
// Coordinates: a sheet's x axis runs along its length, its y axis along its width, with the
// origin at a corner. A placed part's `rotated` is false when the part's length runs along the
// sheet's length.

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

/** Which way a sheet's grain runs: along its length, along its width, or none (MDF). */
export type Grain = 'length' | 'width' | 'none';

export interface SheetPart {
  id: string;
  /** Along the part's grain, when it has one. */
  length: number;
  width: number;
  quantity: number;
  /** The part's length must run along the sheet's grain. Ignored on sheets with no grain. */
  grainLocked: boolean;
}

export interface SheetStock {
  id: string;
  length: number;
  width: number;
  /** How many sheets are available. Absent means unlimited. */
  quantity?: number;
  grain: Grain;
  /** Price per sheet. Used for ranking only when every stock has one. */
  cost?: number;
}

/**
 * Material trimmed off each edge before parts are cut, measured from the sheet's edge to the
 * usable area (the blade's kerf for a trim cut falls inside the trim). `lengthStart` and
 * `lengthEnd` shorten the length (the edges at x = 0 and x = length); `widthStart` and
 * `widthEnd` narrow the width.
 */
export interface SheetTrims {
  lengthStart: number;
  lengthEnd: number;
  widthStart: number;
  widthEnd: number;
}

export interface SheetSettings {
  /** Width of material a cut removes. */
  kerf: number;
  /** One number for every edge, or per edge (missing edges are 0). Default 0. */
  trims?: number | Partial<SheetTrims>;
  /**
   * Most stages a layout may use. A stage is a set of parallel cuts: in a two-stage layout the
   * sheet is cut into strips and the strips are cut into parts, and nothing else (a part that
   * would need trimming to width after that is a third stage). Trim cuts are not counted.
   * Default 'unlimited'.
   */
  maxStages?: number | 'unlimited';
  /**
   * A leftover counts as an offcut (reusable) when its longer side is at least `length` and its
   * shorter side at least `width`; smaller leftovers are waste. Default 0 x 0: every leftover is
   * an offcut.
   */
  minOffcut?: { length: number; width: number };
  /** Seed of the random attempts. Default 1. */
  seed?: number;
  /** Extra attempts that perturb the best rule's part order. Default 30. */
  randomAttempts?: number;
}

export interface SheetInput {
  parts: readonly SheetPart[];
  stock: readonly SheetStock[];
  settings: SheetSettings;
}

export interface Rect {
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
}

export interface Placement extends Rect {
  partId: string;
  /** Which copy of the part, from 1. */
  copy: number;
  /** True when the part's length runs along the sheet's width. */
  rotated: boolean;
}

export type Axis = 'x' | 'y';

/**
 * The guillotine cut tree of one sheet. Its root is the usable (trimmed) area. A cut node
 * splits its rectangle with a line across the whole rectangle: for `axis: 'x'` the line is at
 * x = `at` (a crosscut, across the sheet's length); for `axis: 'y'` at y = `at` (a rip). The
 * first child is the side below `at`; the blade removes [at, at + kerf]; the second child is
 * the rest, or null when nothing is left after the kerf.
 */
export type CutTree = CutTreeCut | CutTreePart | CutTreeLeftover;

export interface CutTreeCut {
  kind: 'cut';
  rect: Rect;
  axis: Axis;
  at: number;
  /** 1 for the first set of parallel cuts, 2 for cuts across those strips, and so on. */
  stage: number;
  first: CutTree;
  second: CutTree | null;
}

export interface CutTreePart {
  kind: 'part';
  rect: Rect;
  /** Index into the sheet's `placements`. */
  placement: number;
}

export interface CutTreeLeftover {
  kind: 'offcut' | 'waste';
  rect: Rect;
}

export interface SheetLayout {
  /** Position of this sheet in the result, from 0. */
  index: number;
  stockId: string;
  length: number;
  width: number;
  /** The area left after trims, where parts go. */
  usable: Rect;
  placements: Placement[];
  cutTree: CutTree;
  /** Leftovers large enough to keep (see `minOffcut`). */
  offcuts: Rect[];
  /** Highest stage of any cut on this sheet (0 when a part fills the usable area). */
  stages: number;
  sheetArea: number;
  partsArea: number;
  offcutArea: number;
  /** Parts area over sheet area. */
  utilisation: number;
  /** Area that is neither part nor offcut (trims, kerf, small leftovers), as a percentage. */
  wastePercent: number;
}

export interface StockUsage {
  stockId: string;
  count: number;
  /** Absent when the stock has no cost. */
  cost?: number;
}

/** The rules of the attempt that produced a result. */
export interface SheetRule {
  sort: SheetSortRule;
  choice: ChoiceRule;
  split: SplitRule;
  stockOrder: StockOrder;
  /** 0 for the rule grid, n for the n-th random perturbation of the best rule's order. */
  perturbation: number;
}

export interface SheetLayoutResult {
  sheets: SheetLayout[];
  unplaced: Unplaced[];
  stock: StockUsage[];
  totals: {
    sheets: number;
    sheetArea: number;
    partsArea: number;
    offcutArea: number;
    utilisation: number;
    wastePercent: number;
    /** Present when every stock used has a cost. */
    cost?: number;
  };
  rule: SheetRule;
  attempts: number;
}

export type SheetSortRule = 'area' | 'long-side' | 'short-side' | 'perimeter' | 'length' | 'width';
export type ChoiceRule = 'best-area' | 'best-short-side' | 'best-long-side';
/**
 * Which of the two cuts that free a placed part from its free rectangle comes first.
 * `x-first` cuts across the length first (crosscuts), `y-first` along it (rips).
 */
export type SplitRule =
  'shorter-leftover-axis' | 'longer-leftover-axis' | 'max-leftover' | 'x-first' | 'y-first';
export type StockOrder = 'input' | 'area-ascending' | 'area-descending';

export const SHEET_SORT_RULES: readonly SheetSortRule[] = [
  'area',
  'long-side',
  'short-side',
  'perimeter',
  'length',
  'width',
];
export const CHOICE_RULES: readonly ChoiceRule[] = [
  'best-area',
  'best-short-side',
  'best-long-side',
];
export const SPLIT_RULES: readonly SplitRule[] = [
  'shorter-leftover-axis',
  'longer-leftover-axis',
  'max-leftover',
  'x-first',
  'y-first',
];

// ---------------------------------------------------------------------------------------------
// Normalised input

interface Settings {
  kerf: number;
  trims: SheetTrims;
  maxStages: number;
  minOffcut: { length: number; width: number };
  seed: number;
  randomAttempts: number;
}

interface Stock extends SheetStock {
  index: number;
  usable: Rect;
}

interface Instance {
  part: SheetPart;
  copy: number;
  /** Position in the canonical (input) order, the final sort tie-break. */
  order: number;
}

/** Resolves the trims setting to four numbers. */
export function resolveTrims(trims: SheetSettings['trims']): SheetTrims {
  if (trims === undefined) return { lengthStart: 0, lengthEnd: 0, widthStart: 0, widthEnd: 0 };
  if (typeof trims === 'number') {
    return { lengthStart: trims, lengthEnd: trims, widthStart: trims, widthEnd: trims };
  }
  return {
    lengthStart: trims.lengthStart ?? 0,
    lengthEnd: trims.lengthEnd ?? 0,
    widthStart: trims.widthStart ?? 0,
    widthEnd: trims.widthEnd ?? 0,
  };
}

/** The usable rectangle of a sheet after trims. */
export function usableRect(stock: { length: number; width: number }, trims: SheetTrims): Rect {
  return {
    x: trims.lengthStart,
    y: trims.widthStart,
    sizeX: stock.length - trims.lengthStart - trims.lengthEnd,
    sizeY: stock.width - trims.widthStart - trims.widthEnd,
  };
}

/** The stage limit as a number (Infinity for 'unlimited'). */
export function resolveMaxStages(maxStages: SheetSettings['maxStages']): number {
  return maxStages === undefined || maxStages === 'unlimited' ? Infinity : maxStages;
}

function normaliseSettings(s: SheetSettings): Settings {
  if (!isNonNegativeFinite(s.kerf)) throw new RangeError(`kerf must be >= 0, got ${s.kerf}`);
  const trims = resolveTrims(s.trims);
  for (const [k, v] of Object.entries(trims)) {
    if (!isNonNegativeFinite(v)) throw new RangeError(`trim ${k} must be >= 0, got ${v}`);
  }
  const maxStages = resolveMaxStages(s.maxStages);
  if (maxStages !== Infinity && !(Number.isInteger(maxStages) && maxStages >= 1)) {
    throw new RangeError(`maxStages must be a positive integer or 'unlimited'`);
  }
  const minOffcut = s.minOffcut ?? { length: 0, width: 0 };
  if (!isNonNegativeFinite(minOffcut.length) || !isNonNegativeFinite(minOffcut.width)) {
    throw new RangeError('minOffcut sizes must be >= 0');
  }
  const randomAttempts = s.randomAttempts ?? 30;
  if (!isQuantity(randomAttempts)) throw new RangeError('randomAttempts must be an integer >= 0');
  const seed = s.seed ?? 1;
  if (!Number.isInteger(seed)) throw new RangeError('seed must be an integer');
  return { kerf: s.kerf, trims, maxStages, minOffcut, seed, randomAttempts };
}

function normaliseStock(stock: readonly SheetStock[], settings: Settings): Stock[] {
  const ids = new Set<string>();
  return stock.map((s, index) => {
    if (ids.has(s.id)) throw new RangeError(`duplicate stock id ${s.id}`);
    ids.add(s.id);
    if (!isPositiveFinite(s.length) || !isPositiveFinite(s.width)) {
      throw new RangeError(`stock ${s.id}: length and width must be > 0`);
    }
    if (s.quantity !== undefined && !isQuantity(s.quantity)) {
      throw new RangeError(`stock ${s.id}: quantity must be an integer >= 0`);
    }
    if (s.cost !== undefined && !isNonNegativeFinite(s.cost)) {
      throw new RangeError(`stock ${s.id}: cost must be >= 0`);
    }
    if (s.grain !== 'length' && s.grain !== 'width' && s.grain !== 'none') {
      throw new RangeError(`stock ${s.id}: grain must be 'length', 'width' or 'none'`);
    }
    const usable = usableRect(s, settings.trims);
    if (usable.sizeX <= EPS || usable.sizeY <= EPS) {
      throw new RangeError(`stock ${s.id}: the trims leave no usable area`);
    }
    return { ...s, index, usable };
  });
}

// ---------------------------------------------------------------------------------------------
// Orientation and stages

interface Oriented {
  sizeX: number;
  sizeY: number;
  rotated: boolean;
}

/** The orientations a part may take on a sheet with the given grain, unrotated first. */
export function orientations(part: SheetPart, grain: Grain): Oriented[] {
  const unrotated = { sizeX: part.length, sizeY: part.width, rotated: false };
  const rotated = { sizeX: part.width, sizeY: part.length, rotated: true };
  if (part.grainLocked && grain === 'length') return [unrotated];
  if (part.grainLocked && grain === 'width') return [rotated];
  if (Math.abs(part.length - part.width) <= EPS) return [unrotated];
  return [unrotated, rotated];
}

/** The stage of a cut along `axis` made on a piece that came from a cut along `parentAxis`. */
export function stageOf(axis: Axis, parentAxis: Axis | null, parentStage: number): number {
  if (parentAxis === null) return 1;
  return axis === parentAxis ? parentStage : parentStage + 1;
}

// ---------------------------------------------------------------------------------------------
// The packer's working tree

type Content =
  | { kind: 'free' }
  | { kind: 'part'; placement: number }
  | { kind: 'cut'; axis: Axis; at: number; stage: number; first: Node; second: Node | null };

interface Node {
  rect: Rect;
  parentAxis: Axis | null;
  parentStage: number;
  content: Content;
}

interface OpenSheet {
  stock: Stock;
  root: Node;
  /** Free rectangles, in a stable order. */
  leaves: Node[];
  placements: Placement[];
}

type Order = 'x-first' | 'y-first';

/** The cut axes needed to free a part of the given size from a leaf, in order, or null. */
function cutPlan(leaf: Node, o: Oriented, split: SplitRule, maxStages: number): Axis[] | null {
  const r = leaf.rect;
  const dX = r.sizeX - o.sizeX;
  const dY = r.sizeY - o.sizeY;
  if (dX < -EPS || dY < -EPS) return null;
  const needX = dX > EPS;
  const needY = dY > EPS;
  if (!needX && !needY) return [];
  if (needX !== needY) {
    const axis: Axis = needX ? 'x' : 'y';
    return stageOf(axis, leaf.parentAxis, leaf.parentStage) <= maxStages ? [axis] : null;
  }
  for (const order of splitPreference(split, leaf, o)) {
    const [a, b]: [Axis, Axis] = order === 'x-first' ? ['x', 'y'] : ['y', 'x'];
    const s1 = stageOf(a, leaf.parentAxis, leaf.parentStage);
    if (stageOf(b, a, s1) <= maxStages) return [a, b];
  }
  return null;
}

function splitPreference(split: SplitRule, leaf: Node, o: Oriented): [Order, Order] {
  const r = leaf.rect;
  const dX = r.sizeX - o.sizeX;
  const dY = r.sizeY - o.sizeY;
  let first: Order;
  switch (split) {
    case 'x-first':
      first = 'x-first';
      break;
    case 'y-first':
      first = 'y-first';
      break;
    case 'shorter-leftover-axis':
      // The larger leftover spans the whole free rectangle.
      first = dX <= dY ? 'y-first' : 'x-first';
      break;
    case 'longer-leftover-axis':
      first = dX <= dY ? 'x-first' : 'y-first';
      break;
    case 'max-leftover': {
      const xFirst = Math.max(dX * r.sizeY, o.sizeX * dY);
      const yFirst = Math.max(r.sizeX * dY, dX * o.sizeY);
      first = yFirst > xFirst ? 'y-first' : 'x-first';
      break;
    }
  }
  return first === 'x-first' ? ['x-first', 'y-first'] : ['y-first', 'x-first'];
}

function choiceScore(choice: ChoiceRule, leaf: Node, o: Oriented): [number, number] {
  const dX = leaf.rect.sizeX - o.sizeX;
  const dY = leaf.rect.sizeY - o.sizeY;
  switch (choice) {
    case 'best-area':
      return [leaf.rect.sizeX * leaf.rect.sizeY - o.sizeX * o.sizeY, Math.min(dX, dY)];
    case 'best-short-side':
      return [Math.min(dX, dY), Math.max(dX, dY)];
    case 'best-long-side':
      return [Math.max(dX, dY), Math.min(dX, dY)];
  }
}

function cutNode(node: Node, axis: Axis, at: number, kerf: number): Node {
  const r = node.rect;
  const stage = stageOf(axis, node.parentAxis, node.parentStage);
  const child = (rect: Rect): Node => ({
    rect,
    parentAxis: axis,
    parentStage: stage,
    content: { kind: 'free' },
  });
  let first: Node;
  let second: Node | null = null;
  if (axis === 'x') {
    first = child({ x: r.x, y: r.y, sizeX: at - r.x, sizeY: r.sizeY });
    const rest = r.x + r.sizeX - (at + kerf);
    if (rest > EPS) second = child({ x: at + kerf, y: r.y, sizeX: rest, sizeY: r.sizeY });
  } else {
    first = child({ x: r.x, y: r.y, sizeX: r.sizeX, sizeY: at - r.y });
    const rest = r.y + r.sizeY - (at + kerf);
    if (rest > EPS) second = child({ x: r.x, y: at + kerf, sizeX: r.sizeX, sizeY: rest });
  }
  node.content = { kind: 'cut', axis, at, stage, first, second };
  return first;
}

function place(
  sheet: OpenSheet,
  leafIndex: number,
  inst: Instance,
  o: Oriented,
  plan: Axis[],
  kerf: number,
): void {
  const leaf = sheet.leaves[leafIndex]!;
  const newLeaves: Node[] = [];
  let target = leaf;
  for (const axis of plan) {
    const at = axis === 'x' ? target.rect.x + o.sizeX : target.rect.y + o.sizeY;
    target = cutNode(target, axis, at, kerf);
  }
  // Collect the second children made by the cuts, outermost first.
  let walk: Node = leaf;
  while (walk.content.kind === 'cut') {
    if (walk.content.second) newLeaves.push(walk.content.second);
    walk = walk.content.first;
  }
  const placement: Placement = {
    partId: inst.part.id,
    copy: inst.copy,
    x: leaf.rect.x,
    y: leaf.rect.y,
    sizeX: o.sizeX,
    sizeY: o.sizeY,
    rotated: o.rotated,
  };
  target.rect = { x: placement.x, y: placement.y, sizeX: o.sizeX, sizeY: o.sizeY };
  target.content = { kind: 'part', placement: sheet.placements.length };
  sheet.placements.push(placement);
  sheet.leaves.splice(leafIndex, 1, ...newLeaves);
}

// ---------------------------------------------------------------------------------------------
// One attempt

interface AttemptRule {
  choice: ChoiceRule;
  split: SplitRule;
  stockOrder: Stock[];
}

interface Attempt {
  sheets: OpenSheet[];
  unplaced: Instance[];
  score: number[];
}

function fitsEmpty(part: SheetPart, stock: Stock, settings: Settings): boolean {
  const root: Node = {
    rect: stock.usable,
    parentAxis: null,
    parentStage: 0,
    content: { kind: 'free' },
  };
  return orientations(part, stock.grain).some(
    (o) =>
      cutPlan(root, o, 'x-first', settings.maxStages) !== null ||
      cutPlan(root, o, 'y-first', settings.maxStages) !== null,
  );
}

function runAttempt(
  instances: readonly Instance[],
  rule: AttemptRule,
  settings: Settings,
  allPriced: boolean,
): Attempt {
  const sheets: OpenSheet[] = [];
  const used = new Map<string, number>();
  const unplaced: Instance[] = [];

  for (const inst of instances) {
    let best: {
      sheet: OpenSheet;
      leaf: number;
      o: Oriented;
      plan: Axis[];
      score: number[];
    } | null = null;
    for (const sheet of sheets) {
      const os = orientations(inst.part, sheet.stock.grain);
      for (let li = 0; li < sheet.leaves.length; li++) {
        const leaf = sheet.leaves[li]!;
        for (const o of os) {
          if (o.sizeX > leaf.rect.sizeX + EPS || o.sizeY > leaf.rect.sizeY + EPS) continue;
          const plan = cutPlan(leaf, o, rule.split, settings.maxStages);
          if (!plan) continue;
          const score = choiceScore(rule.choice, leaf, o);
          if (!best || compareScores(score, best.score) < 0) {
            best = { sheet, leaf: li, o, plan, score };
          }
        }
      }
    }
    if (!best) {
      // Open a new sheet: the first stock in the rule's order that is left and holds the part.
      for (const stock of rule.stockOrder) {
        if (stock.quantity !== undefined && (used.get(stock.id) ?? 0) >= stock.quantity) continue;
        const sheet: OpenSheet = {
          stock,
          root: { rect: stock.usable, parentAxis: null, parentStage: 0, content: { kind: 'free' } },
          leaves: [],
          placements: [],
        };
        sheet.leaves.push(sheet.root);
        for (const o of orientations(inst.part, stock.grain)) {
          const plan = cutPlan(sheet.root, o, rule.split, settings.maxStages);
          if (!plan) continue;
          const score = choiceScore(rule.choice, sheet.root, o);
          if (!best || compareScores(score, best.score) < 0) {
            best = { sheet, leaf: 0, o, plan, score };
          }
        }
        if (best) {
          sheets.push(sheet);
          used.set(stock.id, (used.get(stock.id) ?? 0) + 1);
          break;
        }
      }
    }
    if (!best) {
      unplaced.push(inst);
      continue;
    }
    place(best.sheet, best.leaf, inst, best.o, best.plan, settings.kerf);
  }

  let cost = 0;
  let area = 0;
  let quality = 0;
  for (const sheet of sheets) {
    cost += sheet.stock.cost ?? 0;
    const sheetArea = sheet.stock.length * sheet.stock.width;
    area += sheetArea;
    for (const leaf of sheet.leaves) {
      if (isOffcut(leaf.rect, settings)) {
        const a = (leaf.rect.sizeX * leaf.rect.sizeY) / sheetArea;
        quality += a * a;
      }
    }
  }
  const score = [unplaced.length, allPriced ? cost : 0, sheets.length, area, -quality];
  return { sheets, unplaced, score };
}

function isOffcut(r: Rect, settings: Settings): boolean {
  const long = Math.max(r.sizeX, r.sizeY);
  const short = Math.min(r.sizeX, r.sizeY);
  return (
    long > EPS && long >= settings.minOffcut.length - EPS && short >= settings.minOffcut.width - EPS
  );
}

function sortInstances(instances: readonly Instance[], rule: SheetSortRule): Instance[] {
  const key = (i: Instance): number[] => {
    const l = i.part.length;
    const w = i.part.width;
    const long = Math.max(l, w);
    const short = Math.min(l, w);
    switch (rule) {
      case 'area':
        return [l * w, long, short];
      case 'long-side':
        return [long, short];
      case 'short-side':
        return [short, long];
      case 'perimeter':
        return [l + w, long];
      case 'length':
        return [l, w];
      case 'width':
        return [w, l];
    }
  };
  return [...instances].sort((a, b) => {
    const c = compareScores(key(b), key(a));
    return c !== 0 ? c : a.order - b.order;
  });
}

function stockOrders(stock: readonly Stock[]): { name: StockOrder; order: Stock[] }[] {
  const out: { name: StockOrder; order: Stock[] }[] = [{ name: 'input', order: [...stock] }];
  if (stock.length < 2) return out;
  const area = (s: Stock) => s.usable.sizeX * s.usable.sizeY;
  const asc = [...stock].sort((a, b) => area(a) - area(b) || a.index - b.index);
  const desc = [...stock].sort((a, b) => area(b) - area(a) || a.index - b.index);
  const same = (a: Stock[], b: Stock[]) => a.every((s, i) => s === b[i]);
  for (const [name, order] of [
    ['area-ascending', asc],
    ['area-descending', desc],
  ] as const) {
    if (!out.some((o) => same(o.order, order))) out.push({ name, order });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Result

function finaliseTree(node: Node, settings: Settings): { tree: CutTree; stages: number } {
  const c = node.content;
  switch (c.kind) {
    case 'free':
      return {
        tree: { kind: isOffcut(node.rect, settings) ? 'offcut' : 'waste', rect: node.rect },
        stages: 0,
      };
    case 'part':
      return { tree: { kind: 'part', rect: node.rect, placement: c.placement }, stages: 0 };
    case 'cut': {
      const first = finaliseTree(c.first, settings);
      const second = c.second ? finaliseTree(c.second, settings) : null;
      return {
        tree: {
          kind: 'cut',
          rect: node.rect,
          axis: c.axis,
          at: c.at,
          stage: c.stage,
          first: first.tree,
          second: second ? second.tree : null,
        },
        stages: Math.max(c.stage, first.stages, second ? second.stages : 0),
      };
    }
  }
}

function collectOffcuts(tree: CutTree, out: Rect[]): void {
  if (tree.kind === 'offcut') out.push(tree.rect);
  if (tree.kind === 'cut') {
    collectOffcuts(tree.first, out);
    if (tree.second) collectOffcuts(tree.second, out);
  }
}

function buildResult(
  attempt: Attempt,
  invalid: Unplaced[],
  stock: readonly Stock[],
  settings: Settings,
  rule: SheetRule,
  attempts: number,
): SheetLayoutResult {
  const sheets: SheetLayout[] = attempt.sheets.map((s, index) => {
    const { tree, stages } = finaliseTree(s.root, settings);
    const offcuts: Rect[] = [];
    collectOffcuts(tree, offcuts);
    const sheetArea = s.stock.length * s.stock.width;
    const partsArea = s.placements.reduce((a, p) => a + p.sizeX * p.sizeY, 0);
    const offcutArea = offcuts.reduce((a, r) => a + r.sizeX * r.sizeY, 0);
    return {
      index,
      stockId: s.stock.id,
      length: s.stock.length,
      width: s.stock.width,
      usable: s.stock.usable,
      placements: s.placements,
      cutTree: tree,
      offcuts,
      stages,
      sheetArea,
      partsArea,
      offcutArea,
      utilisation: partsArea / sheetArea,
      wastePercent: (100 * (sheetArea - partsArea - offcutArea)) / sheetArea,
    };
  });

  const unplaced: Unplaced[] = [...invalid];
  const byPart = new Map<string, { quantity: number; reason: UnplacedReason }>();
  for (const inst of attempt.unplaced) {
    const entry = byPart.get(inst.part.id);
    if (entry) {
      entry.quantity++;
    } else {
      const fitsSome = stock.some((s) => fitsEmpty(inst.part, s, settings));
      byPart.set(inst.part.id, { quantity: 1, reason: fitsSome ? 'out-of-stock' : 'does-not-fit' });
    }
  }
  for (const [partId, e] of byPart) unplaced.push({ partId, ...e });

  const usage: StockUsage[] = [];
  for (const s of stock) {
    const count = sheets.filter((sh) => sh.stockId === s.id).length;
    if (count === 0) continue;
    usage.push(
      s.cost === undefined
        ? { stockId: s.id, count }
        : { stockId: s.id, count, cost: s.cost * count },
    );
  }

  const sheetArea = sheets.reduce((a, s) => a + s.sheetArea, 0);
  const partsArea = sheets.reduce((a, s) => a + s.partsArea, 0);
  const offcutArea = sheets.reduce((a, s) => a + s.offcutArea, 0);
  const totals: SheetLayoutResult['totals'] = {
    sheets: sheets.length,
    sheetArea,
    partsArea,
    offcutArea,
    utilisation: sheetArea > 0 ? partsArea / sheetArea : 0,
    wastePercent: sheetArea > 0 ? (100 * (sheetArea - partsArea - offcutArea)) / sheetArea : 0,
  };
  if (usage.every((u) => u.cost !== undefined)) {
    totals.cost = usage.reduce((a, u) => a + (u.cost ?? 0), 0);
  }
  return { sheets, unplaced, stock: usage, totals, rule, attempts };
}

// ---------------------------------------------------------------------------------------------
// Public entry points

/**
 * Lays out the parts, one attempt per step. Yields progress after each attempt and returns the
 * best result. Breaking out of the loop cancels the run; `layoutSheets` and
 * `layoutSheetsAsync` drive it to the end.
 *
 * Throws RangeError on invalid stock or settings, or a duplicate part id. A part with an
 * invalid size is reported as unplaced (`invalid`) instead.
 */
export function* layoutSheetsSteps(
  input: SheetInput,
): Generator<Progress, SheetLayoutResult, void> {
  const settings = normaliseSettings(input.settings);
  const stock = normaliseStock(input.stock, settings);
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
    if (!isPositiveFinite(part.length) || !isPositiveFinite(part.width)) {
      invalid.push({ partId: part.id, quantity: part.quantity, reason: 'invalid' });
      continue;
    }
    for (let copy = 1; copy <= part.quantity; copy++) {
      instances.push({ part, copy, order: instances.length });
    }
  }

  const orders = stockOrders(stock);
  const grid: { sort: SheetSortRule; choice: ChoiceRule; split: SplitRule; so: number }[] = [];
  for (const sort of SHEET_SORT_RULES) {
    for (const choice of CHOICE_RULES) {
      for (const split of SPLIT_RULES) {
        for (let so = 0; so < orders.length; so++) grid.push({ sort, choice, split, so });
      }
    }
  }
  // The random attempts only run when there is more than one copy to reorder.
  const total = grid.length + (instances.length > 1 ? settings.randomAttempts : 0);

  let best: { attempt: Attempt; rule: SheetRule; order: Instance[] } | null = null;
  let done = 0;
  const sorted = new Map<SheetSortRule, Instance[]>();
  for (const g of grid) {
    let order = sorted.get(g.sort);
    if (!order) {
      order = sortInstances(instances, g.sort);
      sorted.set(g.sort, order);
    }
    const so = orders[g.so]!;
    const attempt = runAttempt(
      order,
      { choice: g.choice, split: g.split, stockOrder: so.order },
      settings,
      allPriced,
    );
    if (!best || compareScores(attempt.score, best.attempt.score) < 0) {
      best = {
        attempt,
        rule: {
          sort: g.sort,
          choice: g.choice,
          split: g.split,
          stockOrder: so.name,
          perturbation: 0,
        },
        order,
      };
    }
    done++;
    yield { attempt: done, total };
  }

  if (best && instances.length > 1) {
    const random = seededRandom(settings.seed);
    const base = best;
    const stockOrder = orders.find((o) => o.name === base.rule.stockOrder)!.order;
    for (let n = 1; n <= settings.randomAttempts; n++) {
      const order = perturb(base.order, random);
      const attempt = runAttempt(
        order,
        { choice: base.rule.choice, split: base.rule.split, stockOrder },
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
    attempt: { sheets: [], unplaced: [], score: [] },
    rule: {
      sort: 'area',
      choice: 'best-area',
      split: 'shorter-leftover-axis',
      stockOrder: 'input',
      perturbation: 0,
    } satisfies SheetRule,
  };
  return buildResult(chosen.attempt, invalid, stock, settings, chosen.rule, done);
}

/** Lays out the parts on stock sheets. Synchronous; see `layoutSheetsSteps`. */
export function layoutSheets(input: SheetInput): SheetLayoutResult {
  const steps = layoutSheetsSteps(input);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Lays out the parts, yielding to the event loop between attempts so a worker can take a
 * cancel message. Rejects with `signal.reason` when the signal is aborted.
 */
export async function layoutSheetsAsync(
  input: SheetInput,
  options: { signal?: AbortSignal } = {},
): Promise<SheetLayoutResult> {
  const steps = layoutSheetsSteps(input);
  for (;;) {
    options.signal?.throwIfAborted();
    const r = steps.next();
    if (r.done) return r.value;
    await yieldToEventLoop();
  }
}

// ---------------------------------------------------------------------------------------------
// Cut sequence

export interface SheetCut {
  /** From 1, in the order to cut. */
  step: number;
  /**
   * `trim` for the factory edges; `rip` for a cut along the sheet's length (axis 'y');
   * `crosscut` for a cut across it (axis 'x').
   */
  kind: 'trim' | 'rip' | 'crosscut';
  /** 0 for trims. */
  stage: number;
  axis: Axis;
  /**
   * Where the cut line is: the first child of the cut ends here and the kerf follows it. For a
   * trim, the edge of the usable area (the blade runs on the waste side).
   */
  at: number;
  /** The piece being cut. */
  piece: Rect;
}

/**
 * The cuts of a sheet in an order a saw can make them: trims (rips, then crosscuts), then every
 * stage-1 cut, then stage 2 and so on; within a stage, a piece is cut before the pieces it
 * makes.
 */
export function cutSequence(sheet: SheetLayout): SheetCut[] {
  const cuts: Omit<SheetCut, 'step'>[] = [];
  const u = sheet.usable;
  const full: Rect = { x: 0, y: 0, sizeX: sheet.length, sizeY: sheet.width };
  // Rip trims run the full length; crosscut trims then span the trimmed width.
  const ripped: Rect = { x: 0, y: u.y, sizeX: sheet.length, sizeY: u.sizeY };
  if (u.y > EPS) cuts.push({ kind: 'trim', stage: 0, axis: 'y', at: u.y, piece: full });
  if (u.y + u.sizeY < sheet.width - EPS) {
    cuts.push({ kind: 'trim', stage: 0, axis: 'y', at: u.y + u.sizeY, piece: full });
  }
  if (u.x > EPS) cuts.push({ kind: 'trim', stage: 0, axis: 'x', at: u.x, piece: ripped });
  if (u.x + u.sizeX < sheet.length - EPS) {
    cuts.push({ kind: 'trim', stage: 0, axis: 'x', at: u.x + u.sizeX, piece: ripped });
  }

  const tree: { cut: CutTreeCut; depth: number; seq: number }[] = [];
  const walk = (node: CutTree, depth: number) => {
    if (node.kind !== 'cut') return;
    tree.push({ cut: node, depth, seq: tree.length });
    walk(node.first, depth + 1);
    if (node.second) walk(node.second, depth + 1);
  };
  walk(sheet.cutTree, 0);
  tree.sort((a, b) => a.cut.stage - b.cut.stage || a.depth - b.depth || a.seq - b.seq);
  for (const { cut } of tree) {
    cuts.push({
      kind: cut.axis === 'y' ? 'rip' : 'crosscut',
      stage: cut.stage,
      axis: cut.axis,
      at: cut.at,
      piece: cut.rect,
    });
  }
  return cuts.map((c, i) => ({ step: i + 1, ...c }));
}
