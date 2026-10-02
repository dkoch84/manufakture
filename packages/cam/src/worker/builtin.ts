// The operations this package ships, registered on the worker's default registry by the worker
// entry (`worker.ts`). Each operation task (T5.2b to T5.2f, T5.5a) adds its line here, for example
// `registry.register('profile', generateProfile)`. The worker answers a kind with no line here
// with a `no-generator` error value.

import { generateFacing } from '../ops/facing';
import { generateDrill } from '../ops/drill';
import { generatePocket } from '../ops/pocket';
import { generateProfile } from '../ops/profile';
import { generateSurface3d } from '../ops/surface3d';
import { generateVCarve } from '../ops/vcarve';
import type { OperationRegistry } from './registry';

export function registerBuiltinOperations(registry: OperationRegistry): OperationRegistry {
  registry.register('profile', generateProfile);
  registry.register('pocket', generatePocket);
  registry.register('drill', generateDrill);
  registry.register('facing', generateFacing);
  registry.register('vcarve', generateVCarve);
  registry.register('surface3d', generateSurface3d);
  return registry;
}
