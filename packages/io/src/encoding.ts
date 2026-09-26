// Imported files are kept in the document as base64 text with a SHA-256 of
// their bytes (see README, "Imported geometry"). Web platform APIs only, so
// it runs the same in the browser, in workers and in Node 22.

/** Base64 of bytes, in chunks so large files do not overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Bytes of base64 text. Throws on text that is not base64. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lower-case hex SHA-256 of bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the document stores for an imported file (core's `ImportSource`). */
export interface ImportSourceData {
  format: 'step' | 'stl';
  fileName: string;
  size: number;
  sha256: string;
  data: string;
}

/** The stored form of an imported file. */
export async function importSource(
  format: 'step' | 'stl',
  fileName: string,
  bytes: Uint8Array,
): Promise<ImportSourceData> {
  return {
    format,
    fileName,
    size: bytes.length,
    sha256: await sha256Hex(bytes),
    data: toBase64(bytes),
  };
}
