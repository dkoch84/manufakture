// Node harness: the pinned QuickJS .wasm read from node_modules and compiled once per process,
// for tests (ADR 0007: workers are testable in Node) and for Node hosts (packages/session). The
// browser passes a URL instead (`ScriptEngine.load({ url })`, the URL from Vite's
// `@jitl/quickjs-wasmfile-release-sync/wasm?url`).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ScriptEngine } from './engine';

let compiled: Promise<WebAssembly.Module> | null = null;
let shared: Promise<ScriptEngine> | null = null;

/** Absolute path of the QuickJS .wasm. */
export function quickjsWasmPath(): string {
  return createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync/wasm');
}

/**
 * The compiled QuickJS module, compiled on first use. A `WebAssembly.Module` can be sent to a
 * worker thread, which then loads its engine with `ScriptEngine.load({ module })` and compiles
 * nothing; every instance still gets memory of its own.
 */
export function nodeScriptModule(): Promise<WebAssembly.Module> {
  if (compiled === null) {
    const next = readFile(quickjsWasmPath()).then((bytes) => WebAssembly.compile(bytes));
    // A failed read or compile is tried again on the next call, not cached.
    next.catch(() => {
      if (compiled === next) compiled = null;
    });
    compiled = next;
  }
  return compiled;
}

/** The process-wide engine (compiled on first use). */
export function nodeScriptEngine(): Promise<ScriptEngine> {
  if (shared === null) {
    const next = nodeScriptModule().then((module) => ScriptEngine.load({ module }));
    next.catch(() => {
      if (shared === next) shared = null;
    });
    shared = next;
  }
  return shared;
}
