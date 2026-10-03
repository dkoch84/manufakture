export const packageName = '@manufakture/drawing';

export {
  MAX_CHAIN_MARKS,
  MAX_CHAIN_POINTS,
  MAX_NUDGE,
  chainSpans,
  layoutChain,
  type ChainDimensionInput,
} from './chain';
export {
  DEFAULT_DIMENSION_STYLE,
  arrowhead,
  estimateTextWidth,
  layoutDimension,
  type AngleDimensionInput,
  type CircleDimensionInput,
  type DimensionInput,
  type DimensionStyle,
  type LinearDimensionInput,
  type SilhouetteDiameterInput,
} from './dimension';
export {
  DEFAULT_LAYERS,
  LAYER_NAMES,
  stroke,
  type DisplayItem,
  type DisplayList,
  type DrawingWarning,
  type HatchItem,
  type LayerName,
  type LayerStyle,
  type LineType,
  type Owner,
  type TextAnchor,
  type TextBaseline,
  type TextItem,
} from './display';
export {
  DEFAULT_DRAWING_STYLE,
  layoutSheet,
  sheetScaleText,
  type DrawingInput,
  type DrawingStyle,
  type NoteInput,
} from './drawing';
export {
  DIAMETER_SIGN,
  dimensionText,
  formatDimensionAngle,
  formatDimensionLength,
  type ValueFormat,
} from './format';
export {
  TAU,
  applyPoint,
  boundsOf,
  curveBounds,
  curveLength,
  curvePoints,
  distanceToCurve,
  ellipsePoint,
  sweep,
  transformCurve,
  unionBounds,
  type Bounds,
  type Curve2,
  type Transform2,
  type Vec2,
} from './geometry';
export { hatchLines } from './hatch';
export { removeHiddenUnderVisible, uncoveredParts, type EdgeClass, type ViewEdge } from './hidden';
export {
  FULL_SIZE,
  IMPERIAL_SCALES,
  METRIC_SCALES,
  chooseScale,
  formatScale,
  modelToPaper,
  paperToModel,
  parseScale,
  scaleFactor,
  type Scale,
  type ScaleParse,
} from './scale';
export {
  SHEET_SIZES,
  SHEET_SIZE_ALIASES,
  SHEET_SIZE_NAMES,
  defaultMargins,
  isSheetSizeName,
  resolveSheetSizeName,
  sheetGeometry,
  type Margins,
  type Orientation,
  type SheetGeometry,
  type SheetInput,
  type SheetSeries,
  type SheetSize,
  type SheetSizeAlias,
  type SheetSizeName,
} from './sheet';
export {
  PITCH_TEXT_HEIGHT,
  layoutPitchSymbol,
  pitchLabels,
  type PitchSymbolInput,
} from './symbols';
export {
  DISCLAIMER_TEXT_HEIGHT,
  MAX_DISCLAIMER_LENGTH,
  MAX_DISCLAIMER_LINES,
  TITLE_BLOCK_HEIGHT,
  TITLE_BLOCK_WIDTH,
  layoutDisclaimer,
  layoutTitleBlock,
  titleBlockBounds,
  wrapText,
  type TitleBlockInput,
} from './title-block';
export {
  placeViews,
  viewBounds,
  type PlacedView,
  type PlacementOptions,
  type ViewAlignment,
  type ViewDisplay,
  type ViewInput,
  type ViewOverlayItem,
  type ViewSection,
} from './view';
