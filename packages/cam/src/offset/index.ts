// The offset engine (T5.2a): Clipper2 adapter, flattening, booleans and the tagged arc refit.

export {
  differenceLoops,
  intersectLoops,
  offsetLoops,
  offsetOpenPaths,
  regionArea,
  regionLoops,
  unionLoops,
} from './engine';
export type { OffsetOptions, OpenOffsetOptions, OpenPath2, Region2 } from './engine';
export { arcChordCount, flattenSegments } from './flatten';
export {
  arcRadius,
  distToLoops,
  distToSegment,
  loopArea,
  loopLength,
  sampleSegment,
  segmentLength,
  segmentPoint,
  signedSweep,
} from './geometry';
export { grblArcPrecheck } from './grbl';
export type { GrblArcPrecheck } from './grbl';
export * from './tolerances';
