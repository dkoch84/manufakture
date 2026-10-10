// The mechanical domain as regen registers it (ADR 0013 decision 1, ADR 0017 decision 1):
// namespace `mech` and the reader of the settings it owns (`domains.mech`). Its model is core's
// typed `mech` section, which core validates and its commands reach; the domain adds meaning
// (checks, the simulation, specifications) through the evaluation stage of decision 15
// (`checks/evaluation.ts`, T9.5a: the checks today; the simulation joins in T9.4b). Its one extension type is `mech.placeholder` (T9.2a): the generic solid of a
// purchased part with no STEP file (`parts/placeholder.ts`). The app's regen worker
// entry and the session's Node host call `registerMech(registry)` at start-up; regen imports no
// domain package.

import type { ExtensionDomain, ExtensionRegistry, JsonValue } from '@manufakture/regen';
import { createMechEvaluation } from './checks/evaluation';
import { PLACEHOLDER_TYPE, placeholderType } from './parts/placeholder';
import { MECH_NAMESPACE, MECH_SETTINGS_VERSION, readMechSettings } from './settings';

/**
 * Bump with any change that can alter what the domain returns to regen, so results built by older
 * domain code are never served from regen's cache (ADR 0004 decision 8).
 */
export const MECH_IMPLEMENTATION = 3;

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
  types: { [PLACEHOLDER_TYPE]: placeholderType },
  // The checks (T9.5a): records keyed by their inputs, cached for the life of the registration.
  evaluation: createMechEvaluation({ implementation: MECH_IMPLEMENTATION }),
};

/** Register the mechanical domain on a regen registry. Returns a function that unregisters it. */
export function registerMech(registry: Pick<ExtensionRegistry, 'registerDomain'>): () => void {
  return registry.registerDomain(mechDomain);
}
