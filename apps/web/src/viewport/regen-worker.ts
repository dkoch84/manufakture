// The app's regen worker entry: regen's own worker (the kernel and the regen engine, ADR 0007
// decision 1) with the domains the app ships registered on regen's default registry (ADR 0013
// decision 1: regen imports no domain package, so the app's entry loads them). In M4 that is the
// woodworking domain (`wood.board`, and the `wood` and `stock` document data). Registration runs
// while the module is evaluated, before the worker handles its first message.
//
// The registry comes from regen's `extensions` module itself, not the package index: the index
// also re-exports the text engine, which the worker loads lazily on the first text, and importing
// it here would put the engine (opentype.js) in the worker's start-up chunk. Both paths are the
// same module, so this is the registry the engine reads. A `@manufakture/regen/extensions` export
// would let this import go through the package; until then it names the file.

import { registerWood } from '@manufakture/domain-wood';
import '@manufakture/regen/worker';
import { defaultExtensions } from '../../../../packages/regen/src/extensions';

registerWood(defaultExtensions);
