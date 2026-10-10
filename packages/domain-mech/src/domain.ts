// The mechanical domain as regen registers it (ADR 0013 decision 1, ADR 0017 decision 1):
// namespace `mech` and the reader of the settings it owns (`domains.mech`). Its model is core's
// typed `mech` section, which core validates and its commands reach; the domain adds meaning
// (checks, the simulation, specifications) in later M9 tasks, through the evaluation hook of
// decision 15 (T9.5a) and the `mech.placeholder` extension type (T9.2a). The app's regen worker
// entry and the session's Node host call `registerMech(registry)` at start-up; regen imports no
// domain package.

import type { ExtensionDomain, ExtensionRegistry, JsonValue } from '@manufakture/regen';
import { MECH_NAMESPACE, MECH_SETTINGS_VERSION, readMechSettings } from './settings';

/**
 * Bump with any change that can alter what the domain returns to regen, so results built by older
 * domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const MECH_IMPLEMENTATION = 1;

/** The domain definition: what `registerMech` registers. */
export const mechDomain: ExtensionDomain = {
  namespace: MECH_NAMESPACE,
  implementation: MECH_IMPLEMENTATION,
  data: {
    [MECH_NAMESPACE]: {
      schemaVersion: MECH_SETTINGS_VERSION,
      read: (data: JsonValue, schemaVersion: number) => readMechSettings(data, schemaVersion),
    },
  },
};

/** Register the mechanical domain on a regen registry. Returns a function that unregisters it. */
export function registerMech(registry: Pick<ExtensionRegistry, 'registerDomain'>): () => void {
  return registry.registerDomain(mechDomain);
}
