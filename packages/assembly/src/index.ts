export const packageName = '@manufakture/assembly';

export type {
  AssemblyInput,
  AssemblyIssue,
  AssemblyWarning,
  ConnectorInput,
  DragReport,
  DragTarget,
  InstanceInput,
  IssueCode,
  MateGroup,
  MateInput,
  MateKind,
  MateLimits,
  MateReport,
  MateStatus,
  Outcome,
  Residual,
  SolveReport,
} from './model';
export { MATE_KINDS, coordinateCount } from './mates';
export { drag, solve } from './solver';
export {
  IDENTITY,
  compose,
  exp,
  invert,
  log,
  pose,
  quatFromAxisAngle,
  quatFromRotationVector,
  rotateVector,
  rotationVector,
  transformPoint,
  type Pose,
  type Quat,
  type Twist,
  type Vec3,
} from './transform';
