// A session worker with no kernel whose `init` waits for the test's word: the engine test holds a
// restart's new worker mid-start this way, to close the engine under it. It announces itself with
// `started` on the `engine-gate` channel and answers when the test posts `go`.

import { workerData } from 'node:worker_threads';
import * as Comlink from 'comlink';

const { port } = workerData as { port: MessagePort };
const gate = new BroadcastChannel('engine-gate');

Comlink.expose(
  {
    init: () =>
      new Promise<void>((resolve) => {
        gate.onmessage = (event) => {
          if ((event as MessageEvent).data === 'go') resolve();
        };
        gate.postMessage('started');
      }),
  },
  port as unknown as Comlink.Endpoint,
);
