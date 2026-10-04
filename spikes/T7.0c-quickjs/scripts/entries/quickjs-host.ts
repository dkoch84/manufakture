// Bundle-size entry: the JavaScript side of the sync QuickJS host (core plus the variant's glue),
// without the .wasm, which is its own asset.
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';

export function load(wasmModule: WebAssembly.Module) {
  return newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule }));
}
