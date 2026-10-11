// The simulation worker (T9.4b): rep and session simulations off the main thread. The protocol
// and the handler are in simulator.ts (`serveSimulations`).

import { serveSimulations, type SimReply, type SimRequest } from './simulator';

const handle = serveSimulations((reply: SimReply) =>
  (self as unknown as Worker).postMessage(reply),
);

self.addEventListener('message', (event: MessageEvent<SimRequest>) => handle(event.data));
