// STEP files as text: recognising one and reading its product names. The
// geometry itself is read and written by the kernel (OCCT's STEP translators,
// `@manufakture/kernel`); this is what the main thread can know without it.

const MAGIC = 'ISO-10303-21;';

/** Whether the bytes start like a STEP (ISO 10303-21) file. */
export function isStep(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).trimStart();
  return head.startsWith(MAGIC);
}

/**
 * The names of the products in a STEP file, in file order: what CAD systems
 * show as body or part names. Strings are decoded per ISO 10303-21 (`''` for
 * a quote, `\X2\...\X0\` for UTF-16, `\X\hh` for Latin-1); OCCT also writes
 * raw UTF-8, which is kept as it is.
 */
export function stepProductNames(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  const out: string[] = [];
  for (const m of text.matchAll(/\bPRODUCT\s*\(\s*'((?:[^']|'')*)'/g))
    out.push(decodeStepString(m[1]!));
  return out;
}

export function decodeStepString(raw: string): string {
  return raw
    .replace(/''/g, "'")
    .replace(/\\X2\\((?:[0-9A-Fa-f]{4})+)\\X0\\/g, (_, hex: string) => {
      let s = '';
      for (let i = 0; i < hex.length; i += 4)
        s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return s;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
}

/**
 * The largest STEP file `checkStepFile` accepts by default, in bytes (20 MiB: core's import limit,
 * `MAX_IMPORT_BYTES`, which this package does not import).
 */
export const MAX_STEP_FILE_BYTES = 20 * 1024 * 1024;

export type StepCheck = { ok: true } | { ok: false; line: number; message: string };

/**
 * A quick check of untrusted bytes said to be a STEP file (a catalog entry's file, ADR 0017
 * decision 7), before they are stored or handed to the kernel: not empty, within `maxBytes`, the
 * ISO 10303-21 signature first, no NUL bytes, a `HEADER;` and a `DATA;` section, and
 * `END-ISO-10303-21;` at the end. Each problem names its line. One linear pass over the bytes, so
 * it cannot hang; the geometry itself is the kernel's to read.
 */
export function checkStepFile(bytes: Uint8Array, maxBytes = MAX_STEP_FILE_BYTES): StepCheck {
  if (bytes.length === 0) return { ok: false, line: 1, message: 'the file is empty' };
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      line: 1,
      message: `the file is ${bytes.length} bytes; at most ${maxBytes} are accepted`,
    };
  }
  if (!isStep(bytes)) {
    return { ok: false, line: 1, message: 'not a STEP file: it does not start with ISO-10303-21;' };
  }
  let line = 1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) line++;
    else if (b === 0) return { ok: false, line, message: 'a NUL byte' };
  }
  const text = new TextDecoder('latin1').decode(bytes);
  const lineAt = (index: number) => {
    let n = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 0x0a) n++;
    return n;
  };
  const header = text.indexOf('HEADER;');
  if (header < 0) return { ok: false, line: 1, message: 'no HEADER; section' };
  const data = text.indexOf('DATA;', header);
  if (data < 0)
    return { ok: false, line: lineAt(header), message: 'no DATA; section after the header' };
  if (!/END-ISO-10303-21;\s*$/.test(text.slice(-4096))) {
    return { ok: false, line, message: 'the file does not end with END-ISO-10303-21;' };
  }
  return { ok: true };
}

export type FileFormat = 'step' | 'stl' | '3mf';

/** What kind of file the bytes are, from their content (the name only breaks ties). */
export function sniffFormat(bytes: Uint8Array, fileName = ''): FileFormat | null {
  if (isStep(bytes)) return 'step';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'stl') return 'stl';
  if (bytes.length >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      80,
      true,
    );
    if (bytes.length === 84 + count * 50) return 'stl';
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256)).trimStart();
  if (
    /^solid\b/.test(head) &&
    /facet|endsolid/.test(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))
  ) {
    return 'stl';
  }
  if (ext === 'step' || ext === 'stp') return 'step';
  return null;
}
