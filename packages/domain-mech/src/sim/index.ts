// The rep and session simulation (ADR 0017 decision 14, task T9.4b): decision 6's lumped,
// deterministic, time-stepped model, productised from the T9.0b spike. `./machine` is the model's
// parameters (plain JSON, SI); `./profile` the load case's motion with its force; `./engine` the
// stepping (`Simulation`, `simulate`, `runSimulation` with a budget and cancellation); `./series`
// the outputs by name and their envelopes, and `simulationEnvelopes` for the checks; `./job` reads
// a load case of the document into a job; `./sessions` counts sessions per charge. The app runs
// jobs in a worker (apps/web/src/mech/sim/); an agent's Node session calls the same functions.

export {
  chargeLimitAt,
  lossPowers,
  packEnergy,
  packOcv,
  radiusAt,
  type SimBrake,
  type SimController,
  type SimMachine,
  type SimMotor,
  type SimMotorThermal,
  type SimNode,
  type SimOcvPoint,
  type SimPack,
  type SimRadius,
  type SimTransmission,
} from './machine';
export {
  NO_FORCE,
  profileDuration,
  segmentScale,
  simProfile,
  type ProfileOptions,
  type SimSegment,
} from './profile';
export {
  Simulation,
  runSimulation,
  simulate,
  type PhaseStats,
  type RunOptions,
  type SimComponents,
  type SimJob,
  type SimLedger,
  type SimOptions,
  type SimResult,
  type SimState,
  type SimStatus,
  type SimWarning,
  type SimWarningCode,
  type ThermalLedger,
} from './engine';
export {
  EnvelopeAccumulator,
  SIM_SERIES,
  simulationEnvelopes,
  type Envelope,
  type LoadCaseRun,
  type SimSeriesName,
} from './series';
export {
  CATALOG_REFERENCE,
  CHARGE_TAPER_START,
  COPPER_ALPHA,
  DEFAULT_LOOP_HZ,
  DEFAULT_MODULATION,
  KT_KV_TOLERANCE,
  NDFEB_ALPHA,
  simulationJob,
  type JobOptions,
  type JobResult,
  type SimContext,
  type SimMissing,
} from './job';
export { sessionsPerCharge, type SessionRun, type SessionsPerCharge } from './sessions';
