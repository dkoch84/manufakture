// Node harness: the pinned QuickJS .wasm read from node_modules and compiled once per process,
// for tests (ADR 0007: workers are testable in Node). The browser passes a URL instead
// (`ScriptEngine.load({ url })`, the URL from Vite's
// `@jitl/quickjs-wasmfile-release-sync/wasm?url`).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ScriptEngine } from './engine';

let shared: Promise<ScriptEngine> | null = null;

/** Absolute path of the QuickJS .wasm. */
export function quickjsWasmPath(): string {
  return createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm');
}

/** The process-wide engine (compiled on first use). */
export function nodeScriptEngine(): Promise<ScriptEngine> {
  shared ??= readFile(quickjsWasmPath()).then((bytes) => ScriptEngine.load({ bytes }));
  return shared;
}
