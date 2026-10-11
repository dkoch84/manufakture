// The bearing checks (task T9.5c): L10 life over the duty cycle, the static factor and the speed
// against the limiting speed, per rolling bearing on a drivetrain's shafts, each naming the load
// case that governs it.

export {
  BEARING_CHECKS,
  BEARING_LIFE_CHECK,
  BEARING_SPEED_CHECK,
  BEARING_STATIC_CHECK,
  bearingLife,
  bearingSpeedCheck,
  bearingStatic,
} from './checks';
export {
  bearingDuties,
  spoolAngle,
  turning,
  type BearingSite,
  type CaseDuty,
  type DrivetrainDuty,
  type Known,
  type Peak,
  type RollingType,
  type TurnSample,
  type Turning,
} from './duty';
