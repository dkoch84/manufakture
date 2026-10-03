// Versioned stored JSON (ADR 0013 decision 4). The helpers moved to the shared `@manufakture/stock`
// with the `stock` namespace (T6.1a), so every domain migrates the same way; re-exported here.

export {
  currentVersion,
  migrate,
  type Json,
  type Migration,
  type Versioned,
} from '@manufakture/stock';
