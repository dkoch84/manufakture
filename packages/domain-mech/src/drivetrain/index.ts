// The drivetrain model (ADR 0017 decision 9, task T9.3a): core stores `mech.drivetrains`; this
// module reads one into numbers (ratios, efficiencies, the speed of each element, each element's
// inertia and where it came from), states them as calc records (overall ratio and efficiency, the
// inertia reflected to the motor and to the output), gives the motor torque for an output torque
// and acceleration, and reports what a stage names that is not there.

export {
  OUTPUT_KIND_TEXT,
  REDUCTION_KINDS,
  STAGE_KIND_TEXT,
  drivetrainChain,
  drivetrainNeeds,
  drivetrainProblemText,
  type DrivetrainChain,
  type DrivetrainContext,
  type DrivetrainProblem,
  type InertiaElement,
  type InertiaSource,
  type OutputKind,
  type StageKind,
  type StageResult,
} from './chain';
export {
  analyseDrivetrain,
  analyseDrivetrains,
  drivetrainWarnings,
  type DrivetrainAnalysis,
} from './analysis';
export {
  DRIVETRAIN_EFFICIENCY,
  DRIVETRAIN_INERTIA,
  DRIVETRAIN_INERTIA_OUTPUT,
  DRIVETRAIN_RATIO,
  INERTIA_UNIT,
  drivetrainRecords,
} from './records';
export { DRIVETRAIN_TORQUE, motorTorque, type PowerFlow, type TorqueQuery } from './torque';
export { combineBodies, principalMoments, spinMoment, type BodyMass } from './inertia';
