// The operations this package ships, registered on the worker's default registry by the worker
// entry (`worker.ts`). Each operation task (T5.2b to T5.2f, T5.5a) adds its line here, for example
// `registry.register('profile', generateProfile)`. The worker answers a kind with no line here
// with a `no-generator` error value.

import { generatePocket } from '../ops/pocket';
import { generateProfile } from '../ops/profile';
import type { OperationRegistry } from './registry';

export function registerBuiltinOperations(registry: OperationRegistry): OperationRegistry {
  registry.register('profile', generateProfile);
  registry.register('pocket', generatePocket);
  return registry;
}
