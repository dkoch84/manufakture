// The joint feature, `wood.joint` (M4 plan T4.2b): six joint kinds, each computed from the frames
// of the two boards it joins and translated to one kernel `tools` input. See README.md.

export { MAX_FINGERS } from './box-joint';
export type { Built, JointHardware, JointWarning } from './common';
export { DEFAULT_DOWEL, MAX_HOLES, POCKET_JIG, POCKET_SCREWS, pocketScrew } from './fasteners';
export { LINEAR_TOL, PARALLEL_TOL, boardOf, pairOf, type Board, type Pair } from './geometry';
export {
  DADO_STOPS,
  JOINT_EXPRESSIONS,
  JOINT_KINDS,
  JOINT_PARAMS,
  JOINT_SCHEMA_VERSION,
  JOINT_TYPE,
  KIND_EXPRESSIONS,
  readJointParams,
  type BoxJointParams,
  type DadoParams,
  type DadoStop,
  type DowelParams,
  type JointKind,
  type JointParams,
  type PocketParams,
  type RabbetParams,
  type TenonParams,
} from './params';
export { jointType, readJointMetadata, translateJoint, type JointMetadata } from './translate';
