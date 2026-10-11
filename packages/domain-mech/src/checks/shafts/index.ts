// The shaft, key and hub checks (task T9.5b): what they read from the model (./model), how their
// records are composed (./working), and the checks themselves (./checks).

export {
  SHAFT_CHECKS,
  SHAFT_CRITICAL_SPEED,
  SHAFT_DEFLECTION,
  SHAFT_FATIGUE,
  SHAFT_KEY,
  SHAFT_PRESS_FIT,
  SHAFT_PRESS_FIT_HUB,
  SHAFT_SLOPE,
  SHAFT_STRESS,
} from './checks';
export {
  SECTION_FEATURES,
  SHAFT_FAMILY,
  shaftSites,
  type SectionFeature,
  type ShaftCase,
  type ShaftSite,
} from './model';
