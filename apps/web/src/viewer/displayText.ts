// Text from a bundle, made safe to show. Every string in a `.mfkview` (the document's name, body,
// part and instance names, materials) comes from whoever wrote the file. React already renders it
// as text, never as markup; this also takes out the characters that can make a name lie about
// itself on screen: bidirectional overrides, embeddings and isolates (a name that reads
// "bracket.mfk" but is stored reversed), other format controls, and C0 and C1 control
// characters. Line breaks and tabs become spaces, runs of spaces collapse, and an over-long name is
// cut with an ellipsis.

// U+061C arabic letter mark, U+200E and U+200F (LRM, RLM), U+202A to U+202E (embeddings and
// overrides), U+2066 to U+2069 (isolates), plus U+200B (zero width space), U+2028 and U+2029
// (line and paragraph separators) and U+FEFF (BOM), and every C0 and C1 control.
// Matching control characters is the point here.
/* eslint-disable no-control-regex */
const HIDDEN =
  /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */
const SPACES = /[\t\n\r\f\u2028\u2029\s]+/g;

/** The longest name shown, in UTF-16 units; the manifest allows longer ones. */
export const MAX_DISPLAY_LENGTH = 120;

/** `text` cleaned for display; `fallback` when nothing visible is left. */
export function displayText(text: string, fallback = 'Untitled', max = MAX_DISPLAY_LENGTH): string {
  const clean = text.replace(HIDDEN, '').replace(SPACES, ' ').trim();
  if (clean.length === 0) return fallback;
  if (clean.length <= max) return clean;
  // Do not cut a surrogate pair in half.
  let end = max - 1;
  const code = clean.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)}\u2026`;
}
