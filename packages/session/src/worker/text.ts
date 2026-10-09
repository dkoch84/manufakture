// A session's text worker (`spawnTextWorker` in node-host.ts): reads user fonts and lays out texts
// in them, run under the watchdog of `createWatchdogOutliner`, so a font that hangs or runs out of
// memory costs this thread, never the session's (ADR 0011's amendment). The wire protocol is
// `serveText`'s, over the parent port.

import { parentPort } from 'node:worker_threads';
import { TextEngine, serveText } from '@manufakture/regen';

const port = parentPort;
if (port === null) throw new Error('The text worker runs in a worker thread.');

const scope: Parameters<typeof serveText>[0] = {
  onmessage: null,
  postMessage: (message) => port.postMessage(message),
};
port.on('message', (data: unknown) => scope.onmessage?.({ data } as MessageEvent));

// Bundled fonts are laid out in the session's thread; this engine reads user fonts only.
serveText(scope, new TextEngine());
