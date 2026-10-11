// @manufakture/calc: engineering formulas that return calc records (M9 plan, decision 4). Pure
// functions over SI numbers with no domain vocabulary; every result names its method, inputs,
// assumptions and published sources, and states a margin against the caller's own limit. Nothing
// here calls a design safe. See README.md.

export const packageName = '@manufakture/calc';

export {
  OutOfRange,
  calc,
  derivedValue,
  fromDerived,
  fromRecord,
  given,
  marginOf,
  type CalcDefinition,
  type CalcInput,
  type CalcRecord,
  type CalcSource,
  type CalcStatus,
  type CalcValue,
  type Given,
  type InputSpec,
  type LimitKind,
  type Param,
  type RecordOptions,
} from './record';
export { REQUIRED_FACTOR, loadFactor, strengthFactor } from './factor';
export {
  cantileverPointLoad,
  cantileverUniformLoad,
  simplySupportedCentreLoad,
  simplySupportedUniformLoad,
} from './beams';
export {
  STANDARD_GRAVITY,
  dunkerleyCriticalSpeed,
  rayleighCriticalSpeed,
  shaftFatigueFactor,
  shaftStress,
  shaftTwist,
  uniformShaftCriticalSpeed,
  type FatigueCriterion,
  type ShaftStation,
} from './shafts';
export {
  fatigueNotchFactor,
  marinEnduranceLimit,
  reliabilityFactor,
  sizeFactor,
  temperatureFactor,
  type FatigueLoading,
  type SurfaceFinish,
} from './fatigue';
export {
  grooveKt,
  holeInPlateKt,
  keyseatKt,
  shoulderFilletKt,
  type ConcentrationLoading,
} from './concentration';
export {
  bearingRatingLife,
  bearingStaticFactor,
  deepGrooveEquivalentLoad,
  equivalentDynamicLoad,
  isoLifeModificationFactor,
  reliabilityLifeFactor,
  type BearingKind,
} from './bearings';
export {
  bearingDutyLife,
  bearingDutyLoad,
  bearingSpeed,
  cubicMeanLoad,
  type DutyStep,
} from './bearing-duty';
export {
  boltOverloadFactor,
  boltProofFactor,
  boltStiffness,
  frustumStiffness,
  memberStiffness,
  preloadFromTorque,
  preloadFromTorqueNutFactor,
  separationFactor,
  seriesStiffness,
  slipFactor,
  tensileStressArea,
} from './bolts';
export { threadStrippingFactor } from './threads';
export {
  elasticCoefficient,
  hertzContactStress,
  lewisBendingStress,
  lewisFormFactor,
  velocityFactor,
  type ToothProfile,
} from './gears';
export {
  beltCentrifugalTension,
  beltWrapAngle,
  flatBeltTensions,
  synchronousBeltTensionFactor,
  synchronousBeltToothFactor,
} from './belts';
export { lameStresses } from './cylinders';
export {
  AWG_SOURCE,
  COPPER_ALPHA_20C,
  COPPER_RESISTIVITY_20C,
  awgArea,
  awgDiameter,
  awgName,
  conductorResistance,
  jouleHeating,
  voltageDrop,
  wireAmpacityHeatBalance,
  wireAmpacityTable,
  type AwgGauge,
  type InsulationRating,
} from './electrical';
export { firstOrderTemperature } from './thermal';
export {
  pointLoadDeflectionAt,
  pointLoadMoment,
  shaftBearingSlope,
  shaftPointLoadDeflection,
} from './shaft-deflection';
export { keyFactor } from './keys';
export { pressFitPressure, pressFitSlipFactor } from './fits';
