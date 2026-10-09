// The slide feature, `wood.slide` (#1200): drawer slides from the hardware catalog, placed between
// a cabinet's board and a drawer's side, counted as hardware lines by the cut list.

export {
  SLIDE_FAMILIES,
  findSlideFamily,
  findSlideSize,
  type SideMountClearance,
  type SlideClearance,
  type SlideFamily,
  type SlideSize,
  type UndermountClearance,
} from './catalog';
export {
  MOUNT_EXPRESSIONS,
  SLIDE_EXPRESSIONS,
  SLIDE_OPENS,
  SLIDE_PARAMS,
  SLIDE_SCHEMA_VERSION,
  SLIDE_TYPE,
  readSlideParams,
  type SlideOpens,
  type SlideParams,
} from './params';
export { readSlideMetadata, slideType, translateSlide, type SlideMetadata } from './translate';
