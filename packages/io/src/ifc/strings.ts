// Text that goes into an IFC file. IFC-SPF is ISO 10303-21 text: strings are quoted with `'`,
// a quote doubles, a backslash doubles, and anything outside printable ASCII is written as a
// `\X2\hhhh\X0\` escape. web-ifc's writer does that escaping itself (checked by the tests: a name
// holding `');#99=IFCWALL($);` reads back as the same name and adds no entity). What it does not
// do safely is reach the escaper with every string: in 0.0.78 a lone UTF-16 surrogate aborts the
// WebAssembly module, a string over about 32,000 code units is silently written as nothing (and
// the entity with it), and characters above U+FFFF come out as surrogate pairs inside `\X2\`,
// which ISO 10303-21 does not allow (that needs `\X4\`). So every string is cleaned here first:
// control characters become spaces, bidirectional controls are removed (as `fileName` does),
// surrogates and characters above U+FFFF become U+FFFD, and the length is capped.

/** IFC4's limit for `IfcLabel` and `IfcIdentifier` (the implementer agreement's 255 characters). */
export const MAX_IFC_LABEL = 255;
/** The most characters of an `IfcText` we write (descriptions). */
export const MAX_IFC_TEXT = 1_000;
/** How long one header string may be; longer header text is split into several strings. */
export const MAX_IFC_HEADER_STRING = 255;
/** The most header strings a split may make. */
export const MAX_IFC_HEADER_STRINGS = 8;

const BIDI = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/**
 * `s` made safe for web-ifc's string writer, at most `max` characters: C0 and C1 controls become
 * spaces, bidirectional controls are dropped, surrogates and characters above U+FFFF become
 * U+FFFD. Every character left is in the Basic Multilingual Plane, outside the surrogate range.
 */
export function ifcString(s: string, max: number = MAX_IFC_LABEL): string {
  let out = '';
  let n = 0;
  // Bound the work as well as the result: a hostile name of a million characters is read only as
  // far as the cap (bidirectional controls that are dropped still count as read).
  const limit = Math.min(s.length, max * 4);
  for (let i = 0; i < limit && n < max; i++) {
    const c = s.charCodeAt(i);
    if (BIDI.has(c)) continue;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += ' ';
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A pair (one astral character) or a lone high surrogate: either way one U+FFFD.
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      out += '�';
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '�';
    else out += s[i];
    n++;
  }
  return out;
}

/**
 * Header text split into strings of at most `MAX_IFC_HEADER_STRING` characters, at spaces where it
 * can, and at most `MAX_IFC_HEADER_STRINGS` of them (the rest is dropped). Each is `ifcString`-clean.
 */
export function ifcHeaderStrings(text: string): string[] {
  const clean = ifcString(text, MAX_IFC_HEADER_STRING * MAX_IFC_HEADER_STRINGS)
    .replace(/ +/g, ' ')
    .trim();
  const out: string[] = [];
  let rest = clean;
  while (rest.length > 0 && out.length < MAX_IFC_HEADER_STRINGS) {
    if (rest.length <= MAX_IFC_HEADER_STRING) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(' ', MAX_IFC_HEADER_STRING);
    if (cut <= 0) cut = MAX_IFC_HEADER_STRING;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return out;
}
