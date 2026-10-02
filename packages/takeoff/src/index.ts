// @manufakture/takeoff: the generic quantity takeoff (ADR 0013 decision 8). Rows of `{ item,
// stock, size, quantity, unit, extended, sources }` that domain producers fill, their merging and
// totals, and their formatting in display units. Imports no domain package. See README.md.

export const packageName = '@manufakture/takeoff';

export {
  MM3_PER_BOARD_FOOT,
  TAKEOFF_UNITS,
  boardFeet,
  buildTakeoff,
  compareIds,
  lengthKey,
  mergeRows,
  mergeSources,
  scaleRow,
  sizeKey,
  totals,
  type Takeoff,
  type TakeoffMeasure,
  type TakeoffRow,
  type TakeoffSize,
  type TakeoffSource,
  type TakeoffTotal,
  type TakeoffUnit,
} from './takeoff';
export {
  UNIT_LABELS,
  formatMeasure,
  formatRow,
  formatSize,
  isImperial,
  type FormattedRow,
} from './format';
