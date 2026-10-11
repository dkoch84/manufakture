// The spool and cable (task T9.3b): the output stage of a winch or trainer. The pure winding
// geometry (layers against cable paid out, effective radius against extension, bend ratio) in
// ./winding; the spool output of a drivetrain read from the document (typed dimensions, the body's
// bounding box, the rope's catalog entry, the requirements) in ./spool; its calc records in
// ./records; both together in ./analysis, which the drivetrain analysis carries.

export {
  MAX_LAYERS,
  bendRatio,
  effectiveRadius,
  layerAt,
  layerRadius,
  layersWound,
  outerSurface,
  radiusSteps,
  spoolAt,
  turnsPerLayer,
  wind,
  type SpoolGeometry,
  type SpoolPoint,
  type WoundLayer,
  type Winding,
} from './winding';
export {
  ROUND_TOLERANCE,
  readBox,
  readSpool,
  spoolNeeds,
  type CableRating,
  type SpoolBox,
  type SpoolCable,
  type SpoolDimension,
  type SpoolOutput,
  type SpoolReading,
  type SpoolRequirement,
} from './spool';
export {
  FLANGE_CLEARANCE_GUIDE,
  SPOOL_BEND_RATIO,
  SPOOL_FAIRLEAD_BEND_RATIO,
  SPOOL_FLANGE_CLEARANCE,
  SPOOL_LAYERS,
  SPOOL_RADIUS_OUT,
  SPOOL_RADIUS_WOUND,
  SPOOL_STRETCH,
  SPOOL_TRAVEL,
  spoolRecords,
} from './records';
export { analyseSpool, type SpoolAnalysis } from './analysis';
