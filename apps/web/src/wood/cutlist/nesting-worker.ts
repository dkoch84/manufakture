// The nesting worker (M4 plan T4.3d): sheet layouts and lumber plans off the main thread. One job
// at a time per message id; a `cancel` stops it between attempts. The protocol is in nester.ts.

import { runNesting } from './nesting';
import type { NesterReply, NesterRequest } from './nester';

const running = new Map<number, AbortController>();
const post = (reply: NesterReply) => (self as unknown as Worker).postMessage(reply);

self.addEventListener('message', (event: MessageEvent<NesterRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    running.get(request.id)?.abort(new Error('cancelled'));
    return;
  }
  const controller = new AbortController();
  running.set(request.id, controller);
  runNesting(request.job, {
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', id: request.id, progress }),
  })
    .then((result) => post({ type: 'done', id: request.id, result }))
    .catch((error: unknown) =>
      post({
        type: 'error',
        id: request.id,
        cancelled: controller.signal.aborted,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => running.delete(request.id));
});
