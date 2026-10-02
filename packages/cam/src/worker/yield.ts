// Yielding to the event loop between chunks of work (ADR 0007 decision 4, as amended for the CAM
// worker), so a newer request or a `cancel` arriving on the port gets a chance to run. The same
// strategy as the print-analysis worker's `createYield` (packages/print/src/worker-api.ts); copied
// rather than imported, since this package may not load other workspace packages at run time
// (ADR 0014 decision 1).

/**
 * The parts of a port used here, typed structurally: this package's config has Node's types and no
 * DOM, and Node's `MessagePort` type lacks `onmessage`, which both runtimes have. `ref` and `unref`
 * are Node's alone.
 */
interface YieldPort {
  onmessage: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  ref?: () => void;
  unref?: () => void;
}

/**
 * A yield that runs as a real macrotask. `setImmediate` where it exists (Node: a woken Node
 * `MessagePort` drains up to 1000 messages in one go, so a chain of yields on a private channel
 * would starve other ports), then a message posted to a private `MessageChannel` (browsers: not
 * clamped like nested timers), then `setTimeout(r, 0)`.
 */
export function createYield(): () => Promise<void> {
  // Read off globalThis so the file also typechecks without Node's types (the web app's config).
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
    .setImmediate;
  if (typeof immediate === 'function') {
    return () => new Promise<void>((r) => immediate(r));
  }
  if (typeof MessageChannel === 'undefined') {
    return () => new Promise<void>((r) => setTimeout(r, 0));
  }
  let channel: { port1: YieldPort; port2: YieldPort } | undefined;
  const waiting: Array<() => void> = [];
  return () =>
    new Promise<void>((resolve) => {
      if (!channel) {
        channel = new MessageChannel() as unknown as { port1: YieldPort; port2: YieldPort };
        const port = channel.port1;
        port.onmessage = () => {
          waiting.shift()?.();
          // In Node an open port with a listener keeps the process alive; hold it only while a
          // yield is pending.
          if (waiting.length === 0) port.unref?.();
        };
      }
      waiting.push(resolve);
      channel.port1.ref?.();
      channel.port2.postMessage(null);
    });
}

/** Milliseconds from a monotonic clock where there is one. */
export const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();
