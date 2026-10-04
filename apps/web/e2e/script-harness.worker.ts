/// <reference types="vite/client" />
// Module worker bundled by scripting-cross-browser.spec.ts: loads the QuickJS .wasm the way the
// regen worker does (its Vite asset URL, streaming compile), runs the example scripts and posts
// the results to the page. A dedicated worker, like the regen worker, so the browser's worker
// stack and the worker Content-Security-Policy are the ones scripts really run under.

import quickjsWasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import { ScriptEngine } from '../../../packages/script/src/index';
import { runExamples } from './script-examples';

const post = (message: unknown) =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

/**
 * Whether this worker may reach another origin (`?other=` names one that answers every request):
 * the worker policy's `connect-src 'self'` must refuse it.
 */
async function otherOrigin(): Promise<string> {
  const other = new URL(self.location.href).searchParams.get('other');
  if (other === null) return 'not tried';
  return fetch(other, { mode: 'no-cors' }).then(
    () => 'allowed',
    () => 'refused',
  );
}

async function main(): Promise<void> {
  const connect = await otherOrigin();
  const engine = await ScriptEngine.load({ url: quickjsWasmUrl });
  post({ ok: true, connect, results: await runExamples(engine) });
}

main().catch((e: unknown) =>
  post({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
);
