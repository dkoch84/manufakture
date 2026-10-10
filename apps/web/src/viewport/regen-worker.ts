// The app's regen worker entry: regen's own worker (the kernel and the regen engine, ADR 0007
// decision 1) with the domains the app ships registered on regen's default registry (ADR 0013
// decision 1: regen imports no domain package, so the app's entry loads them): the shared stock
// reader (`domains.stock`, owned by `@manufakture/stock` since ADR 0015 decision 1), the
// woodworking domain (`wood.*` and `domains.wood`), the construction domain
// (`domains.construction`) and the mechanical domain (`domains.mech`). Registration runs while the
// module is evaluated, before the worker handles its first message.
//
// The registry comes from `@manufakture/regen/extensions`, not the package index: the index also
// re-exports the text engine, which the worker loads lazily on the first text, and importing it
// here would put the engine (opentype.js) in the worker's start-up chunk. Both resolve to the same
// module, so this is the registry the engine reads.

import { registerConstruction } from '@manufakture/domain-construction';
import { registerMech } from '@manufakture/domain-mech';
import { registerWood } from '@manufakture/domain-wood';
import { defaultExtensions } from '@manufakture/regen/extensions';
import { registerStock } from '@manufakture/stock';
import '@manufakture/regen/worker';

registerStock(defaultExtensions);
registerWood(defaultExtensions);
registerConstruction(defaultExtensions);
registerMech(defaultExtensions);
