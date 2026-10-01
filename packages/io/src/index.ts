// @manufakture/io: file formats. STL and 3MF are read and written here in
// plain TypeScript; STEP geometry goes through the kernel (OCCT's
// translators), and this package only reads STEP text (product names).

export const packageName = '@manufakture/io';

export {
  DEFAULT_WELD_TOLERANCE,
  meshProperties,
  mergeMeshes,
  weld,
  type MeshProperties,
  type NamedMesh,
  type TriMesh,
  type TriangleSoup,
  type Vec3,
  type WeldOptions,
} from './mesh';
export { checkManifold, type ManifoldOptions, type ManifoldReport } from './manifold';
export {
  StlParseError,
  parseStl,
  writeBinaryStl,
  type ParsedStl,
  type StlWriteOptions,
} from './stl';
export {
  CORE_NAMESPACE,
  MATERIALS_NAMESPACE,
  MODEL_PATH,
  MODEL_SETTINGS_PATH,
  ThreeMfParseError,
  buildMeshes,
  parse3mf,
  validate3mf,
  write3mf,
  type ModelUnit,
  type ParsedThreeMf,
  type ThreeMfBuildItem,
  type ThreeMfBuiltMesh,
  type ThreeMfColorGroup,
  type ThreeMfComponent,
  type ThreeMfComponentsInput,
  type ThreeMfItem,
  type ThreeMfMeshInput,
  type ThreeMfObject,
  type ThreeMfObjectInput,
  type ThreeMfReport,
  type ThreeMfSettingsObject,
  type ThreeMfWriteOptions,
} from './threemf';
export {
  IDENTITY_MATRIX,
  composeMatrices,
  matrixDeterminant,
  placementMatrix,
  transformMesh,
  type Matrix3x4,
  type Placement,
} from './placement';
export { decodeStepString, isStep, sniffFormat, stepProductNames, type FileFormat } from './step';
export { fromBase64, importSource, sha256Hex, toBase64, type ImportSourceData } from './encoding';
export {
  DEFAULT_EXPORT_TOLERANCE,
  EXPORT_TOLERANCES,
  NotWatertightError,
  deflectionOf,
  export3mf,
  export3mfAssembly,
  exportMesh,
  exportStl,
  exportStlAssembly,
  fileName,
  type ExportAssembly,
  type ExportBody,
  type ExportTolerance,
  type ExportTolerancePreset,
  type StlFile,
} from './export';
