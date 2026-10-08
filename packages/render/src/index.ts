// @manufakture/render: views of a regen result as PNG, without a browser (M8 plan, T8.2a; the
// design is T8.0b's software rasteriser, docs/spikes/T8.0b-render.md). See the README.

export { buildScene, creaseEdges } from './scene';
export type { CachedBodyMesh, Scene, SceneInput, SceneMesh } from './scene';
export {
  DEFAULT_HEIGHT,
  DEFAULT_SUPERSAMPLE,
  DEFAULT_WIDTH,
  render,
  renderRgb,
  renderViews,
} from './render';
export type { RasterImage } from './raster';
export { resolveCamera } from './camera';
export type { ViewBasis } from './camera';
export { encodePng } from './png';
export { BACKGROUND, BODY_PALETTE, HIGHLIGHT, HIGHLIGHT_EDGE, INK, memberColor } from './colors';
export { MAX_IMAGES_PER_CALL, MAX_IMAGE_SIDE, MAX_SAMPLES } from './types';
export type {
  Camera,
  Framing,
  RenderError,
  RenderErrorCode,
  RenderOptions,
  RenderResult,
  RenderedView,
  Rgb,
  SectionPlane,
  Vec3,
} from './types';
