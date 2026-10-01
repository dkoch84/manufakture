// Text for sketches: fonts and layout. Glyph outlines come out as paths
// (`PathCommand[]` from `@manufakture/sketch`), which `outlineRegions` turns
// into region loops. Pure TypeScript; parse fonts in a worker.

export {
  BUNDLED_FONTS,
  DEFAULT_FONT_ID,
  INTER_BOLD,
  bundledFont,
  bundledFontUrl,
  fetchBundledFont,
  type BundledFont,
} from './bundled';
export {
  FontError,
  MAX_FONT_BYTES,
  embeddingPermissions,
  fontSha256,
  loadFont,
  type EmbeddingPermissions,
  type FontErrorCode,
  type FontInfo,
  type LoadedFont,
} from './font';
export { MAX_COMPONENT_DEPTH, MAX_GLYPH_POINTS, MAX_GLYPH_SCAN } from './glyf';
export { MAX_KERN_LOOKUP_INDEXES, MAX_KERN_SUBTABLES } from './kerning';
export {
  layoutText,
  type LaidOutGlyph,
  type TextLayout,
  type TextLayoutOptions,
  type TextLine,
} from './layout';
export { MAX_CMAP_CODE_POINTS } from './sfnt';
