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
