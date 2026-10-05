// The feature kinds, on their own so the face-name parser (names.ts) can read them without
// loading the schema and zod: the viewer reaches the parser by the `@manufakture/core/names`
// subpath and must not load the rest of core (apps/web/src/viewer/bundleCheck.ts). schema.ts
// re-exports the list.

export const FEATURE_KINDS = [
  'sketch',
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
  'extension',
  'import',
  'derived',
  'thread',
  'scripted',
] as const;
