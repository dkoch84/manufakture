// Solver worker: owns one planegcs instance and one DragSession. Each `move`
// request is one pointermove: re-solve and send every parameter back.

import type { GcsWrapper } from '@salusoft89/planegcs';
import { DragSession } from './bench.ts';
import { loadWrapper } from './load-browser.ts';
import type { Request, Response } from './protocol.ts';

let wrapper: GcsWrapper | null = null;
let session: DragSession | null = null;

function reply(message: Response, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const m = event.data;
  try {
    switch (m.type) {
      case 'init': {
        const t0 = performance.now();
        wrapper = await loadWrapper(m.memoryPages);
        reply({ type: 'init', initMs: performance.now() - t0 });
        break;
      }
      case 'setup': {
        if (!wrapper) throw new Error('init first');
        session = new DragSession(wrapper, m.spec);
        reply({ type: 'setup', setup: session.setup() });
        break;
      }
      case 'move': {
        if (!session) throw new Error('setup first');
        const r = session.move(m.i);
        // The session reuses its buffer, so send a copy and transfer that.
        const params = r.params.slice();
        reply(
          {
            type: 'move',
            status: r.status,
            solveMs: r.solveMs,
            moveMs: r.moveMs,
            errorMm: r.errorMm,
            params,
          },
          [params.buffer],
        );
        break;
      }
      case 'ping':
        reply({ type: 'ping' });
        break;
    }
  } catch (e) {
    reply({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
