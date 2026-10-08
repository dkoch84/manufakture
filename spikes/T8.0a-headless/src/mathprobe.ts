// The JavaScript Math functions regen's own TypeScript calls (domain translators, the framing
// stage, sketch and member geometry), each over a fixed list of inputs, as raw float64 bits: run
// in Node and in the browser and compared value by value, so a geometry difference between them
// can be traced to the function that differs. Browser-safe.

/** Inputs: a sweep of [-4, 4], the roof pitches 1/12 to 24/12 and their angles, a few specials. */
function inputs(): number[] {
  const xs: number[] = [];
  for (let i = -400; i <= 400; i++) xs.push(i / 100 + i * 1e-7);
  for (let rise = 1; rise <= 24; rise++) {
    xs.push(rise / 12, Math.atan(rise / 12));
  }
  xs.push(0.5, Math.atan(0.5), Math.PI / 6, Math.PI / 4, Math.PI / 3, 1e-9, 1234.5678);
  return xs;
}

type Fn = (x: number) => number;

export const MATH_FUNCTIONS: Record<string, Fn> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  asin: (x) => Math.asin(Math.max(-1, Math.min(1, x / 4))),
  acos: (x) => Math.acos(Math.max(-1, Math.min(1, x / 4))),
  atan2: (x) => Math.atan2(x, 1.75),
  hypot2: (x) => Math.hypot(x, 1.75),
  hypot3: (x) => Math.hypot(x, 1.75, -0.3),
  sqrt: (x) => Math.sqrt(Math.abs(x)),
  exp: Math.exp,
  log: (x) => Math.log(Math.abs(x) + 1e-3),
  pow: (x) => Math.pow(Math.abs(x) + 0.5, 1.37),
  cbrt: Math.cbrt,
};

/** Per function, every result's bits as a hex string (16 digits each), concatenated. */
export function mathProbe(): Record<string, string[]> {
  const xs = inputs();
  const view = new DataView(new ArrayBuffer(8));
  const out: Record<string, string[]> = {};
  for (const [name, fn] of Object.entries(MATH_FUNCTIONS)) {
    out[name] = xs.map((x) => {
      view.setFloat64(0, fn(x));
      return view.getBigUint64(0).toString(16).padStart(16, '0');
    });
  }
  return out;
}

/** Per function: how many results differ, and the largest difference in units in the last place. */
export function compareMath(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): Record<string, { inputs: number; differ: number; maxUlp: number }> {
  const out: Record<string, { inputs: number; differ: number; maxUlp: number }> = {};
  for (const name of Object.keys(a)) {
    const x = a[name]!;
    const y = b[name] ?? [];
    let differ = 0;
    let maxUlp = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      differ++;
      const d = BigInt(`0x${x[i]}`) - BigInt(`0x${y[i]}`);
      maxUlp = Math.max(maxUlp, Number(d < 0n ? -d : d));
    }
    out[name] = { inputs: x.length, differ, maxUlp };
  }
  return out;
}
