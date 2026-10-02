// The operations this package ships, registered on the worker's default registry by the worker
// entry (`worker.ts`). Each operation task (T5.2b to T5.2f, T5.5a) adds its line here, for example
// `registry.register('profile', generateProfile)`. Until then the worker answers every operation
// with a `no-generator` error value.

import type { OperationRegistry } from './registry';

export function registerBuiltinOperations(registry: OperationRegistry): OperationRegistry {
  return registry;
}
