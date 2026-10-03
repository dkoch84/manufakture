// The material-removal simulation and gouge check (T5.3c).

export {
  SIM_CELLS_PER_DIAMETER,
  SIM_DEFAULT_DRILL_ANGLE,
  SIM_MAX_CELLS,
  SIM_MIN_CELL,
  SIM_VBIT_CUT_WIDTH,
  SIM_Z_STEP,
  cellX,
  cellY,
  gridFor,
  profileHeight,
  simCellSize,
  simCutWidth,
  stampPoint,
  sweepMove,
  toolProfile,
} from './heightfield';
export type { CellVisitor, SimCellTool, SimGrid, ToolProfile } from './heightfield';
export { meshToMachine, partBands, rasterPart, upSign } from './part';
export {
  MaterialSimulation,
  SIM_CLASS,
  SIM_COLLISION_TOLERANCE,
  SIM_DEFLECTION,
  SIM_GRAZE,
  SIM_MAX_SNAPSHOTS,
  SIM_SNAPSHOT_BYTES,
  SIM_TOLERANCE,
} from './simulation';
export type {
  SimCollision,
  SimComparison,
  SimReport,
  SimWorst,
  SimulationOptions,
  SimulationProgram,
} from './simulation';
export { SimulationSession, frameTransferables, simulateHeightmap } from './session';
export type {
  CamSimFrame,
  CamSimProgram,
  CamSimulateProgramReply,
  CamSimulateProgramRequest,
  SessionOutcome,
} from './session';
