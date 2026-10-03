// The construction takeoff (M6 plan T6.3a): framing and sheet-goods producers on
// `@manufakture/takeoff`'s model, with cost from the stock overrides' prices.

export { constructionTakeoff, DEFAULT_TAKEOFF_SETTINGS } from './takeoff';
export {
  LINEAR_GROUPS,
  PRECUT_ROLES,
  PRECUT_TOLERANCE,
  ROLE_LABELS,
  SPLICE_ROLES,
  framingTakeoff,
  precutFor,
  type FramingContext,
  type FramingResult,
} from './framing';
export { LAYER_LABELS, sheetTakeoff, type SheetContext, type SheetResult } from './sheets';
export {
  faceArea,
  faceOrientation,
  layoutFace,
  roofSheathingFaces,
  subfloorFace,
  wallFace,
  type FaceOpening,
  type SheetSize,
  type WallFaceInput,
} from './faces';
export { priceRows, stickPrice, stockBoardFeet, unitCost } from './cost';
export {
  CONSTRUCTION_CATEGORIES,
  type ConstructionCategory,
  type ConstructionFlag,
  type ConstructionRow,
  type ConstructionTakeoff,
  type ConstructionTakeoffInput,
  type ConstructionTakeoffSettings,
  type CostSummary,
  type FaceLayout,
  type FacePiece,
  type FaceRect,
  type LumberStockLayout,
  type SheetFace,
  type SheetLayerKind,
  type SheetStockLayout,
  type TakeoffMember,
  type TakeoffSubtotal,
} from './types';
