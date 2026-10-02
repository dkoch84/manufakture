// clipper2-wasm 0.4.0 points `types` at dist/es/clipper2z.d.ts, which it does not ship; the
// declarations are one level up. This maps the ES entry to them.
declare module 'clipper2-wasm/dist/es/clipper2z.js' {
  import type { Clipper2ZFactoryFunction } from 'clipper2-wasm/dist/clipper2z';
  const factory: Clipper2ZFactoryFunction;
  export default factory;
}
