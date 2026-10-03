// Deterministic IFC GlobalIds (T6.6a): the same document exported twice gives every element the
// same GlobalId, so a BIM tool that loaded the first export recognises the second as an update
// of the same objects. A GlobalId is a 128-bit GUID written as 22 characters of IFC's base-64
// alphabet. Ours is a name-based UUID (version 8, RFC 9562 variant) whose bits are the first 128
// of SHA-256 over the document id and the element's key; random GUIDs (web-ifc's
// `CreateIFCGloballyUniqueId`) would change on every export.

/** IFC's base-64 alphabet for compressed GUIDs (not RFC 4648's). */
export const IFC_GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** A GlobalId's form: 22 characters, the first encoding only the top two bits. */
export const IFC_GUID_PATTERN = /^[0-3][0-9A-Za-z_$]{21}$/;

/** 16 bytes as IFC's 22-character compressed GUID. */
export function compressGuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError('a GUID is 16 bytes');
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = IFC_GUID_ALPHABET[Number(n & 63n)]! + out;
    n >>= 6n;
  }
  return out;
}

/** The 128 bits of a compressed GUID (the inverse of `compressGuid`). */
export function expandGuid(guid: string): Uint8Array {
  if (!IFC_GUID_PATTERN.test(guid)) throw new RangeError('not an IFC GlobalId');
  let n = 0n;
  for (const ch of guid) n = (n << 6n) | BigInt(IFC_GUID_ALPHABET.indexOf(ch));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

/**
 * The GlobalId of the element `key` in the document `documentId`. Both are length-prefixed in
 * the hashed text, so no two (document, key) pairs hash the same text.
 */
export async function ifcGlobalId(documentId: string, key: string): Promise<string> {
  const text = `${documentId.length}:${documentId}|${key.length}:${key}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  return compressGuid(bytes);
}
