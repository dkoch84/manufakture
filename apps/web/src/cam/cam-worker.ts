// The app's CAM worker entry (T5.1g; ADR 0014 decision 7): `@manufakture/cam`'s own worker, which
// registers the operations the package ships and exposes `CamWorkerApi`. Operations the app adds
// would be registered here on `defaultOperations` (from `@manufakture/cam`), before the worker
// handles its first message, as regen-worker.ts does for domains.

import '@manufakture/cam/worker';
