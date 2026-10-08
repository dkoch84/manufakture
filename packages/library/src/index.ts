// @manufakture/library: the document library (storage, revisions, named versions, branches,
// merge, `.mfk` files) on any `StorageBackend`. The app gives it OPFS or IndexedDB; Node gives it
// a directory (`@manufakture/library/node`). The `.mfk` zip code is `@manufakture/library/mfk`,
// which the library itself loads on first use. See README.md.

export * from './backend';
export * from './blobs';
export * from './export-gate';
export * from './library';
export * from './limits';
export * from './locks';
export * from './walk';
