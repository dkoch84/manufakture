// The cross-browser determinism script: trigonometry and the other implementation-approximated
// Math functions, Math.pow, and number formatting, over a fixed set of inputs. It is plain
// ECMAScript returning a JSON string, so the same source runs inside QuickJS and on the host
// engine (V8, SpiderMonkey, JavaScriptCore). Doubles are reported as the hex of their 64 bits,
// so a comparison is bit for bit.

export const DETERMINISM_SCRIPT = String.raw`(() => {
  const dv = new DataView(new ArrayBuffer(8));
  const hex = (x) => {
    dv.setFloat64(0, x);
    let s = '';
    for (let i = 0; i < 8; i++) s += dv.getUint8(i).toString(16).padStart(2, '0');
    return s;
  };
  const xs = [];
  for (let i = 0; i < 400; i++) xs.push((i - 200) * 0.0371 + i * i * 1.3e-4);
  xs.push(1e10, 1e22, 1e300, 2 ** 53, 2 ** 53 + 2, 710, 709.78, 1e-300, 5e-324, 0.5, -0.5, 1 / 3,
    Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI, 3 * Math.PI / 2, 100 * Math.PI, 1e6 * Math.PI,
    Math.E, Math.LN2, Math.SQRT2, 0.1, 0.2, 0.3, 1.1, 22.5, 45, 90, 180, 359.999);
  const unary = ['sin', 'cos', 'tan', 'atan', 'exp', 'expm1', 'sinh', 'cosh', 'tanh', 'cbrt',
    'asinh', 'sqrt', 'round', 'fround'];
  const math = {};
  for (const f of unary) math[f] = xs.map((x) => hex(Math[f](x)));
  const pos = xs.map((x) => Math.abs(x) + 1e-3);
  for (const f of ['log', 'log1p', 'log2', 'log10', 'acosh']) math[f] = pos.map((x) => hex(Math[f](x + 1)));
  const unit = xs.map((x) => Math.sin(x) * 0.999);
  for (const f of ['asin', 'acos', 'atanh']) math[f] = unit.map((x) => hex(Math[f](x)));
  math.atan2 = xs.map((x, i) => hex(Math.atan2(x, xs[(i * 7) % xs.length])));
  math.hypot = xs.map((x, i) => hex(Math.hypot(x, xs[(i * 13) % xs.length], 3)));
  math.powCube = pos.map((x) => hex(Math.pow(x, 1 / 3)));
  math.powFrac = pos.map((x) => hex(Math.pow(x, 2.5)));
  math.powBase = xs.map((x) => hex(Math.pow(1.1, x)));
  math.powTen = [];
  for (let k = -330; k <= 310; k++) math.powTen.push(hex(Math.pow(10, k)));
  math.starStar = xs.map((x) => hex(Math.abs(x) ** 0.7));
  const deg = [];
  for (let d = 0; d < 360; d += 7.5) deg.push(hex(Math.cos(d * Math.PI / 180)), hex(Math.sin(d * Math.PI / 180)));
  math.degrees = deg;
  const spiral = [];
  for (let i = 0; i < 200; i++) {
    const t = i * 0.1;
    spiral.push(hex(10 * Math.cos(t) * Math.exp(0.05 * t)), hex(10 * Math.sin(t) * Math.exp(0.05 * t)));
  }
  math.spiral = spiral;
  const fmt = [];
  const nums = xs.concat([123.456, 0.000001234, 1e21, 1e-7, 123456789012345680000, 1.005, 2.675,
    1.45, 8.345, -1.5e-10, 4.35, 0.1 + 0.2, 1 / 7, 2 / 3, 25.4, 3.175, 6.35]);
  for (const x of nums) {
    fmt.push(String(x), x.toFixed(2), x.toFixed(6), x.toPrecision(4), x.toPrecision(17),
      x.toExponential(), x.toExponential(8), JSON.stringify(x));
    if (Math.abs(x) < 1e15) fmt.push(x.toString(2), x.toString(16), x.toString(36));
  }
  for (const s of ['0.1', '1e-7', '123.456e3', '  42  ', '0x1f', '1_000', '.5', '5.', '-0', 'Infinity',
    '1.7976931348623157e308', '4.9e-324', '2.2250738585072014e-308'])
    fmt.push(hex(Number(s)), hex(parseFloat(s)));
  const order = [];
  const arr = [];
  for (let i = 0; i < 64; i++) arr.push((i * 37) % 64);
  let k = 1;
  // An inconsistent comparator: the result depends on the engine's sort algorithm.
  order.push(arr.slice().sort(() => ((k = (k * 1103515245 + 12345) % 2147483648) % 3) - 1).join(','));
  order.push(arr.slice().sort((a, b) => a - b).join(','));
  return JSON.stringify({ math, fmt, order });
})()`;

export interface DeterminismOutput {
  math: Record<string, string[]>;
  fmt: string[];
  order: string[];
}

/** Flatten to `key -> value` entries for a bit-for-bit comparison. */
export function flatten(output: DeterminismOutput): Map<string, string> {
  const out = new Map<string, string>();
  for (const [f, values] of Object.entries(output.math)) {
    values.forEach((v, i) => out.set(`math.${f}[${i}]`, v));
  }
  output.fmt.forEach((v, i) => out.set(`fmt[${i}]`, v));
  output.order.forEach((v, i) => out.set(`order[${i}]`, v));
  return out;
}

/** Keys whose values differ between two outputs (and keys present in only one). */
export function differences(a: DeterminismOutput, b: DeterminismOutput): string[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  return [...keys].filter((k) => fa.get(k) !== fb.get(k));
}
