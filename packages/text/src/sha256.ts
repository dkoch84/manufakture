// The SHA-256 of a font file, kept apart from the parser so that code needing only bundled font
// metadata (`@manufakture/text/bundled`) does not load opentype.js.

/** Lower-case hex SHA-256 of a font file, as documents record it (ADR 0011). */
export async function fontSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
