// A stand-in for apps/web/src/persistence/mfk.ts (the `.mfk` file packer), which the library loads
// only for `exportMfk` and `importMfk`. The spike uses neither, and the real one imports `fflate`
// and app code this folder cannot resolve; these keep the library's types and refuse at run time.

export class MfkError extends Error {}

export const MFK_LIMITS = { maxEntries: 1000 };

export interface MfkContents {
  document: string;
  manifest: string | null;
  versions: Map<string, string>;
  blobs: Map<string, Uint8Array>;
}

export function packMfk(
  _document: string,
  _blobs: ReadonlyMap<string, Uint8Array> | Iterable<unknown>,
  _extras?: unknown,
): Uint8Array {
  throw new MfkError('.mfk files are not part of this spike');
}

export function unpackMfk(_bytes: Uint8Array): MfkContents {
  throw new MfkError('.mfk files are not part of this spike');
}
