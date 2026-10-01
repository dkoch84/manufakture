// Text for sketches: fonts and layout. Glyph outlines come out as paths
// (`PathCommand[]` from `@manufakture/sketch`), which `outlineRegions` turns
// into region loops. Pure TypeScript; parse fonts in a worker.

// opentype.js ships no types. The declarations of the part this package uses must reach every
// program that compiles these sources (regen, the app), not only this package's own, and an
// ambient module declaration cannot be imported: so a reference, here at the entry point.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./opentype.d.ts" />

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
