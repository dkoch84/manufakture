// The description in a STEP file's header (ISO 10303-21 `FILE_DESCRIPTION`; moved here from the
// app in M8 plan T8.1b): the STEP export writes the construction domain's short disclaimer there
// for a document with construction features (ADR 0015 decision 8), as the IFC export does. The
// kernel writes OCCT's own description; this splices the new one into the header's bytes, leaving
// every other byte of the file as it was.

/** Longest string written per description entry, so no header line runs very long. */
const MAX_ENTRY = 200;

/**
 * `text` as STEP string entries: ASCII only, backslashes doubled (a lone backslash starts an
 * ISO 10303-21 control directive), then quotes doubled, split at spaces.
 */
export function stepStrings(text: string): string[] {
  const ascii = text.replace(/[^\x20-\x7e]/g, '?');
  const out: string[] = [];
  let line = '';
  for (const word of ascii.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (next.length > MAX_ENTRY && line !== '') {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') out.push(line);
  return out.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
}

const DESCRIPTION = /FILE_DESCRIPTION\s*\(\s*\((?:[^()']|'(?:[^']|'')*')*\)\s*,/;

/** `ENDSEC;` as bytes: the end of the header section. */
const ENDSEC = [...'ENDSEC;'].map((c) => c.charCodeAt(0));

function indexOfBytes(bytes: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** ASCII bytes as a string, one character per byte (a STEP header is ASCII). */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

/**
 * The STEP file with `text` as its header's description (the implementation level after it is
 * kept). Only the header is read and only the description's bytes are replaced; the rest of the
 * file is copied byte for byte, whatever its encoding. The file unchanged when it has no
 * `FILE_DESCRIPTION` in its header.
 */
export function withStepDescription(bytes: Uint8Array, text: string): Uint8Array {
  const end = indexOfBytes(bytes, ENDSEC);
  // One character per byte, so string indices are byte offsets.
  const header = latin1(end < 0 ? bytes : bytes.subarray(0, end));
  const m = DESCRIPTION.exec(header);
  if (m === null) return bytes;
  const replaced = `FILE_DESCRIPTION((${stepStrings(text).join(',')}),`;
  const out = new Uint8Array(bytes.length - m[0].length + replaced.length);
  out.set(bytes.subarray(0, m.index), 0);
  for (let i = 0; i < replaced.length; i++) out[m.index + i] = replaced.charCodeAt(i);
  out.set(bytes.subarray(m.index + m[0].length), m.index + replaced.length);
  return out;
}
