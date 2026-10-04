// The TypeScript erasure choice for T7.2b (ADR 0010 decision 7): bundle size of each candidate
// (Vite library build, minified, brotli), erase time for a typical script, and how each treats
// TypeScript that is not plain type annotations.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { transform } from 'sucrase';
import tsBlankSpace from 'ts-blank-space';
import { build } from 'vite';

const SPIKE_DIR = new URL('..', import.meta.url).pathname;

export function brotli(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}

export interface BundleSize {
  entry: string;
  rawBytes: number;
  brotliBytes: number;
}

/** Minified ES bundle of one entry, every dependency included. */
export async function bundleSize(entry: string): Promise<BundleSize> {
  const outDir = join(SPIKE_DIR, 'dist', 'bundles', entry);
  await build({
    root: SPIKE_DIR,
    configFile: false,
    logLevel: 'warn',
    // Not library mode: that inlines every asset, the .wasm included, as base64. Here the
    // .wasm is emitted as its own file and only JavaScript is counted.
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      target: 'es2022',
      rollupOptions: {
        input: join(SPIKE_DIR, 'scripts', 'entries', `${entry}.ts`),
        preserveEntrySignatures: 'exports-only',
      },
    },
    // Node built-ins some packages mention are not part of a browser bundle.
    resolve: { conditions: ['browser', 'import', 'default'] },
  });
  let raw = 0;
  let compressed = 0;
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js') || p.endsWith('.mjs')) {
        const bytes = readFileSync(p);
        raw += bytes.length;
        compressed += brotli(bytes);
      }
    }
  };
  walk(outDir);
  return { entry, rawBytes: raw, brotliBytes: compressed };
}

/** A typical scripted feature in TypeScript, with only erasable syntax. */
export const SAMPLE = `// A bolt circle: N holes on a circle, in a plate.
interface Params {
  diameter: number;
  holes: number;
  hole: number;
  thickness: number;
}
type Vec2 = readonly [number, number];
type Handle = number & { readonly __brand: 'handle' };
interface Ctx {
  sketch(id: string, loops: Vec2[][]): Handle;
  extrude(id: string, sketch: Handle, depth: number): Handle;
  cut(id: string, body: Handle, tool: Handle): Handle;
}

export const parameters = [
  { name: 'diameter', kind: 'length', default: 80, min: 10 },
  { name: 'holes', kind: 'number', default: 6, min: 1, max: 64 },
  { name: 'hole', kind: 'length', default: 6 },
  { name: 'thickness', kind: 'length', default: 5 },
] as const satisfies readonly { name: string; kind: string; default: number }[];

function circle(cx: number, cy: number, r: number, segments = 32): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)] as const);
  }
  return out;
}

function boltCircle<T extends Params>(p: T): Vec2[][] {
  const loops: Vec2[][] = [];
  for (let i = 0; i < p.holes; i++) {
    const a = (i / p.holes) * 2 * Math.PI;
    loops.push(circle((p.diameter / 2) * Math.cos(a), (p.diameter / 2) * Math.sin(a), p.hole / 2));
  }
  return loops;
}

export function run(ctx: Ctx, p: Params): Handle {
  const size = p.diameter + 4 * p.hole;
  const plate = ctx.extrude('plate', ctx.sketch('outline', [[[-size / 2, -size / 2], [size / 2, -size / 2],
    [size / 2, size / 2], [-size / 2, size / 2]]]), p.thickness);
  let body: Handle = plate;
  boltCircle(p).forEach((loop, i) => {
    const tool = ctx.extrude(\`hole\${i}\`, ctx.sketch(\`h\${i}\`, [loop]), p.thickness * 3) as Handle;
    body = ctx.cut(\`cut\${i}\`, body, tool);
  });
  return body!;
}
`;

/** TypeScript that is more than annotations: what does each tool do with it? */
export const NON_ERASABLE: Record<string, string> = {
  enum: 'enum Side { Left, Right }\nexport const s = Side.Left;',
  'const enum': 'const enum Side { Left, Right }\nexport const s = Side.Right;',
  namespace: 'namespace Geo { export const k = 2; }\nexport const g = Geo.k;',
  'parameter property':
    'class P { constructor(private x: number) {} get() { return this.x; } }\nexport const v = new P(3).get();',
  'import = require': "import fs = require('fs');",
  decorator: 'function d(t: unknown) { return t; }\n@d class C {}\nexport const c = new C();',
  'angle-bracket assertion': 'const x = <number>(1 as unknown);\nexport const y = x;',
  'type-only import': "import type { Foo } from './foo';\nexport const z: Foo | null = null;",
  // Erasable syntax of TypeScript 4.9 to 5.x, which an older parser could miss.
  satisfies: 'export const o = { a: 1 } satisfies Record<string, number>;',
  'const type parameter':
    'export function f<const T extends readonly unknown[]>(x: T): T { return x; }',
  'generic arrow': 'export const id = <T,>(x: T): T => x;',
  'accessor field': 'export class A { accessor n: number = 1; }',
  'definite assignment': 'let x!: number;\nx = 1;\nexport const y = x;',
};

export interface ErasureCase {
  case: string;
  tool: 'ts-blank-space' | 'sucrase';
  outcome: string;
}

export function eraseWith(
  tool: ErasureCase['tool'],
  source: string,
): { code: string; errors: number } {
  if (tool === 'ts-blank-space') {
    let errors = 0;
    const code = tsBlankSpace(source, () => {
      errors++;
    });
    return { code, errors };
  }
  return {
    code: transform(source, { transforms: ['typescript'], disableESTransforms: true }).code,
    errors: 0,
  };
}

export function nonErasableCases(): ErasureCase[] {
  const out: ErasureCase[] = [];
  for (const [label, source] of Object.entries(NON_ERASABLE)) {
    for (const tool of ['ts-blank-space', 'sucrase'] as const) {
      let outcome: string;
      try {
        const r = eraseWith(tool, source);
        const oneLine = r.code.replace(/\s+/g, ' ').trim().slice(0, 90);
        outcome =
          r.errors > 0
            ? `reports unsupported (${r.errors}); output: ${oneLine}`
            : `output: ${oneLine}`;
      } catch (e) {
        outcome = `throws: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`;
      }
      out.push({ case: label, tool, outcome });
    }
  }
  return out;
}

/** Line and column of every `Math` in the source and the output: equal means positions kept. */
export function positionsKept(source: string, code: string): boolean {
  const where = (text: string) => {
    const out: string[] = [];
    text.split('\n').forEach((line, i) => {
      let at = line.indexOf('Math.');
      while (at >= 0) {
        out.push(`${i}:${at}`);
        at = line.indexOf('Math.', at + 1);
      }
    });
    return out.join(',');
  };
  return where(source) === where(code);
}

/** Lines only: equal line numbers of every `Math`. */
export function linesKept(source: string, code: string): boolean {
  const lines = (text: string) =>
    text
      .split('\n')
      .flatMap((line, i) => (line.includes('Math.') ? [i] : []))
      .join(',');
  return lines(source) === lines(code);
}
