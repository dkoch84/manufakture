// The fonts that ship with the app (ADR 0011): files under `packages/text/fonts/`,
// served as their own assets and fetched as bytes when a document first needs
// text. They are never imported as modules, inlined or base64-encoded into the
// JavaScript; `new URL(..., import.meta.url)` makes the bundler emit the file
// as a separate asset and gives its URL.
//
// A bundled font's id is stable for its family and weight; its SHA-256 changes
// only when the file is deliberately updated, which documents detect (T3.2c).

import { fontSha256 } from './font';

export interface BundledFont {
  /** Stable id documents record: `{ kind: 'bundled', id, sha256 }`. */
  id: string;
  family: string;
  style: string;
  /** The font's own version string (name 5). */
  version: string;
  fileName: string;
  /** Bytes. */
  size: number;
  /** Lower-case hex SHA-256 of the file. */
  sha256: string;
  /** SPDX identifier. */
  license: string;
  /** The copyright line from the font's license file. */
  copyright: string;
}

export const INTER_BOLD: BundledFont = {
  id: 'inter-bold',
  family: 'Inter',
  style: 'Bold',
  version: 'Version 4.001;git-9221beed3',
  fileName: 'Inter-Bold.ttf',
  size: 420428,
  sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f',
  license: 'OFL-1.1-no-RFN',
  copyright: 'Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)',
};

export const BUNDLED_FONTS: readonly BundledFont[] = [INTER_BOLD];

/** The bundled font new text uses unless the user picks another. */
export const DEFAULT_FONT_ID = INTER_BOLD.id;

export function bundledFont(id: string): BundledFont | undefined {
  return BUNDLED_FONTS.find((font) => font.id === id);
}

/** Where a bundled font's file is: a separate asset next to the bundle, or a file URL in Node. */
export function bundledFontUrl(id: string): URL {
  switch (id) {
    // One literal URL per font, so bundlers can see and emit each file.
    case INTER_BOLD.id:
      return new URL('../fonts/Inter-Bold.ttf', import.meta.url);
    default:
      throw new Error(`Unknown bundled font "${id}".`);
  }
}

/**
 * Fetches a bundled font's bytes and checks them against the recorded SHA-256,
 * so a damaged or substituted asset fails instead of changing geometry.
 */
export async function fetchBundledFont(
  id: string,
  fetchImpl: (url: URL) => Promise<Response> = (url) => fetch(url),
): Promise<ArrayBuffer> {
  const font = bundledFont(id);
  if (!font) throw new Error(`Unknown bundled font "${id}".`);
  const response = await fetchImpl(bundledFontUrl(id));
  if (!response.ok)
    throw new Error(`The bundled font "${id}" could not be loaded (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const sha256 = await fontSha256(bytes);
  if (sha256 !== font.sha256) {
    throw new Error(`The bundled font "${id}" does not match its recorded SHA-256 (${sha256}).`);
  }
  return bytes;
}
