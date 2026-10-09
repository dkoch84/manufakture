// stdout belongs to the protocol (main.ts). Imported first, before any module that may print, this
// takes process.stdout's `write` for the transport alone (`protocolOut`) and sends everything
// else written to stdout, and `console.log`, `console.info` and `console.debug`, to stderr. The
// kernel's own output goes to stderr already (STDERR_OUTPUT), and so does a session worker's
// stdout (packages/session's engine); this catches whatever else prints.

import { Writable } from 'node:stream';

const toStdout = process.stdout.write.bind(process.stdout) as (
  chunk: string | Uint8Array,
  callback?: (error?: Error | null) => void,
) => boolean;

/** The transport's own writable, on the process's real stdout (fd 1). */
export const protocolOut = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    toStdout(chunk, (error) => callback(error ?? null));
  },
});

/** Ends the transport's writable; resolves once everything it took has reached stdout. */
export function flushProtocol(): Promise<void> {
  return new Promise((resolve) => {
    if (protocolOut.writableFinished) return resolve();
    protocolOut.once('finish', () => resolve());
    protocolOut.once('error', () => resolve());
    protocolOut.end();
  });
}

process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
