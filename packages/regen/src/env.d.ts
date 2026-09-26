// Vite's `?url` import of the kernel binary (see worker.ts). Declared here so the package
// typechecks without Vite's client types.
declare module 'libcascade/single/wasm?url' {
  const url: string;
  export default url;
}
