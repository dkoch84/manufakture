// Vite's `?url` imports of the kernel binary and web-ifc's (see worker.ts). Declared here so the package
// typechecks without Vite's client types.
declare module 'libcascade/single/wasm?url' {
  const url: string;
  export default url;
}

declare module 'web-ifc/web-ifc.wasm?url' {
  const url: string;
  export default url;
}
