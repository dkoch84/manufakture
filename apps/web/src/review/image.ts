// Checking a review bundle's image before it is shown (ReviewImage): the reference the bundle
// gives (`ImageRef`), then the bytes stored under it.

import { sha256Hex } from '@manufakture/io';
import { LIMITS } from '@manufakture/review/data';
import { num, obj, text } from './review';

/** The largest width or height shown, in pixels (the bundle's default is 800 x 600). */
export const MAX_IMAGE_SIDE = 4096;

const SHA256 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface CheckedRef {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

/** The reference, when every field is what an image reference holds; else null. */
export function checkedRef(value: unknown): CheckedRef | null {
  const r = obj(value);
  const sha256 = text(r.sha256);
  const [bytes, width, height] = [num(r.bytes), num(r.width), num(r.height)];
  if (!SHA256.test(sha256) || bytes === null || width === null || height === null) return null;
  const side = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > LIMITS.imageBytes) return null;
  if (!side(width) || !side(height)) return null;
  return { sha256, bytes, width, height };
}

/** Why `bytes` are not the image `ref` names, or null when they are. */
export async function imageProblem(bytes: Uint8Array, ref: CheckedRef): Promise<string | null> {
  if (bytes.length !== ref.bytes) return 'The image is not the size the bundle says.';
  if ((await sha256Hex(bytes)) !== ref.sha256) return 'The image does not match its SHA-256.';
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    return 'The image is not a PNG.';
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) !== ref.width || view.getUint32(20) !== ref.height) {
    return 'The image is not the width and height the bundle says.';
  }
  return null;
}
