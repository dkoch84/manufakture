// @manufakture/review: the review bundle (ADR 0016 decision 11; M8 plan T8.3a). What an agent's
// branch changed, as data plus images, built in the session where the work was done and read in
// the app where it is approved. `bundleBuilder` is the session's `BundleBuilder` hook. Node only
// (the builder regenerates on a kernel); the app reads bundles through `@manufakture/review/data`.
// See README.md.

export {
  DEFAULT_WORKBENCH_LIMITS,
  bodyDeltas,
  buildBundle,
  bundleBuilder,
  mergeError,
  mergePreview,
  regenIssues,
  type BuildInput,
  type BuiltBundle,
  type BundleBuilderOptions,
} from './bundle';
export {
  assemblyScene,
  type AssemblyAt,
  type AssemblyPoseWarning,
  type AssemblySceneResult,
  type PosedAssemblyView,
} from './assembly';
export {
  MAX_COMMAND_MISMATCHES,
  branchLog,
  commandDiff,
  commandMismatches,
  type CommandList,
  type LogSource,
  type LoggedBatch,
} from './commands';
export { isStale, readBundle, type BranchHead } from './data';
export { Names, describeFeature, featureKind, featureTitle } from './describe';
export { assemblyDiffs, documentChanges, movedIds, partDiffs, scriptDiffs } from './diff';
export {
  DEFAULT_SUMMARISERS,
  domainDiffs,
  domainLines,
  summariserMap,
  type DomainSummariser,
} from './domains';
export { quantityDeltas, type HeadPhases } from './quantities';
export {
  DEFAULT_IMAGE_SIZE,
  FIXED_VIEWS,
  MAX_VIEW_POSES,
  renderPairs,
  reviewViews,
  sceneBox,
  sharedCamera,
  type ImageSize,
  type ReviewView,
  type SceneSource,
} from './renders';
export { SUMMARIES, changesText, summarise, type SummaryContext } from './summaries';
export * from './types';
export { Workbench, WorkbenchTimeout, type SideReport, type WorkbenchLimits } from './workbench';
