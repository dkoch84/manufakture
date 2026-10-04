# @manufakture/script

Runs a user's JavaScript or TypeScript against a host API it is given, in QuickJS compiled to WebAssembly, with the capabilities, limits and determinism rules of [ADR 0010](../../docs/adr/0010-scripting-sandbox.md). The regen worker uses it to build scripted features (T7.2c); the starting values and choices come from the [T7.0c spike](../../docs/spikes/T7.0c-quickjs.md).

- **Engine**: Bellard's QuickJS 2025-09-13, the synchronous release build of quickjs-emscripten 0.32.0 (`quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`, pinned exactly). Its `.wasm` (503,134 bytes, 199,016 brotli) is a separate asset, compiled once per worker. No asyncify: host functions are synchronous and reach the kernel through a synchronous session.
- **TypeScript**: erased with sucrase 3.35.1 (pinned). Type checking is an editor matter, never a regen step.
- **Size** of the JavaScript side in a Vite build (this package, sucrase and the QuickJS host): 305 KB raw, 54 KB brotli, plus the variant's Emscripten glue.

## Entry points

| Import                     | Where        | What                                                                                                         |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `@manufakture/script`      | worker, Node | `ScriptEngine`, `ScriptInstance`, host API types, `resolveParams`, limits, versions, errors, `prepareSource` |
| `@manufakture/script/node` | Node (tests) | `nodeScriptEngine()`: the `.wasm` read from `node_modules` and compiled once per process                     |

## Using it

```ts
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url'; // Vite asset URL
import { ScriptEngine, kernelOp, resolveParams, ScriptHandle } from '@manufakture/script';

const engine = await ScriptEngine.load({ url: wasmUrl }); // once per worker
const doc = await engine.createInstance(); // once per document (and per carried source document)

const script = { source, language: 'ts', apiVersion: 1 } as const; // as stored (T7.2a)

// The cheap first run: top-level code only, no ctx. Gives the parameter dialog its fields.
const decl = await doc.readDeclarations(script);
if (!decl.ok) return featureError(decl.error);

// Stored values (evaluated expressions, resolved references) plus defaults.
const params = resolveParams(decl.value.params, evaluated);
if (!params.ok) return featureError(params.error);

const out = await doc.run({
  ...script,
  seed: feature.seed, // integer, default 0
  params: params.value,
  host: {
    extrude: kernelOp((id, profile, distance) => new ScriptHandle('body', makeShape(/* ... */))),
    measure: { volume: (body) => volumeOf((body as ScriptHandle<Shape>).value) },
  },
});
if (!out.ok) return featureError(out.error); // { code, message, line?, column?, stack? }
```

Runs on one instance are serial; a run holds it until it returns. `run` and `readDeclarations` are async only because an instance dropped after a fatal error is re-made (about 1 ms) before the next run; the script itself runs synchronously. `doc.dispose()` drops the instance when the document closes. Promise jobs are never executed after a run; a run that leaves any behind (`Promise.resolve().then(...)`) still returns its result, and the instance is dropped rather than disposing the context under them.

## What a script looks like (API version 1)

```ts
export const apiVersion = 1; // optional; the stored stamp is what counts, and they must agree

export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  count: { kind: 'number', default: 6, min: 1, max: 64, integer: true },
  tilt: { kind: 'angle', default: 0 },
  rounded: { kind: 'boolean', default: true },
  style: { kind: 'choice', options: ['round', 'square'], default: 'round' },
  face: { kind: 'reference', select: 'face', optional: true },
};

export function run(ctx, params) {
  const body = ctx.extrude('boss', sketch, params.width);
  return { volume: ctx.measure.volume(body) };
}
```

- The module may export `run` (required), `params` and `apiVersion`, and nothing else is read. It runs in strict mode as an ES module, but it cannot `import` anything (refused before running, with the position); everything comes from `ctx`.
- `run` returns its result directly. Async functions, promises and top-level `await` are refused: there are no jobs after a run.
- **Parameter declarations** (`ParamDeclaration`, exported): `number`, `length` and `angle` with a finite `default` and optional `min`, `max` (and `integer` for `number`); `boolean` with a `default`; `choice` with distinct string `options` and a `default` among them; `reference` with `select` (`face`, `edge`, `vertex`, `body`) and optional `multiple` and `optional` flags. All take an optional `label` and `description`. Unknown fields are refused, so a script cannot depend on a field a later API version adds. At most 64 parameters, named like identifiers. Lengths are millimetres and angles radians (ADR 0005); the dialog formats them. `readDeclarations` returns them as `ParamSpec[]` in declaration order.
- **Values in the scripted feature** (T7.2a): one per parameter name, a `StoredExpression` for the numeric kinds and a reference for `reference`. Regen evaluates them and calls `resolveParams`, which fills defaults, checks kinds and ranges (`bad-param`), and drops names the script no longer declares, so removing a parameter does not break existing features.

## Values across the boundary

A host function receives its arguments as `ScriptValue`s and returns one: numbers, strings, booleans, null, arrays, plain objects of those, and `ScriptHandle`s. In detail:

- NaN, the infinities and -0 cross both ways as themselves (JSON alone would turn them into null and 0). NaN is canonical on the host side; whether a host function accepts non-finite numbers is its own decision (geometry must refuse them, ADR 0010 decision 5).
- `undefined` means "no value" at the top level; inside arrays it becomes null and inside objects its key is dropped, as in JSON.
- Functions, symbols, BigInts, class instances, `Map`s, typed arrays and objects with a `__proto__` key are refused with a `TypeError` the script can catch.
- A `ScriptHandle` (`new ScriptHandle(kind, value)`) reaches the script as a frozen object with only `kind`; passed back, the host function receives the same `ScriptHandle`. Handles live for one run.
- Host functions marked with `kernelOp(fn)` count against the operation limit; plain functions are queries. A host function that throws `ScriptHostError` fails the call with an ordinary `Error` the script can catch; any other exception ends the run with `host-error`.

## Limits

All configurable per instance (`createInstance({ limits })`) and per run (`limits` in the request; `heapBytes` applies when an instance is made). Every limit is a typed `ScriptError`, and a script cannot catch its way past one: after a limit hit every host call and guarded builtin refuses to run and the interrupt handler stops the script at its next check.

| Limit                    | Default                             | Enforced by                                                                                                                                           | Error             |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `timeMs`                 | 2,000 ms per run                    | QuickJS's interrupt handler, every host call (before and after), and the builtin guards (below). Module evaluation counts.                            | `timeout`         |
| `heapBytes`              | 64 MiB per instance                 | the instance's `WebAssembly.Memory` maximum (16 MiB the `.wasm` needs plus this); `setMemoryLimit` too, which refuses single huge allocations at once | `heap-limit`      |
| `stackBytes`             | 128 KiB                             | `setMaxStackSize`: about 680 frames, below Chromium's worker stack                                                                                    | `stack-limit`     |
| `kernelOps`              | 1,000 per run                       | count of `kernelOp` calls                                                                                                                             | `op-limit`        |
| `hostCalls`              | 100,000 per run                     | count of all host calls (0.1 to 0.25 s of binding cost)                                                                                               | `call-limit`      |
| `maxStringLength`        | 1 MiB (UTF-16 units)                | each string and key crossing, both ways                                                                                                               | `value-too-large` |
| `maxElements`            | 100,000                             | array elements plus object properties in one value, at any depth, both ways                                                                           | `value-too-large` |
| `maxDepth`               | 64                                  | nesting of one value, both ways (checked on the JSON text before the host parses it)                                                                  | `value-too-large` |
| `maxPayloadLength`       | 8 MiB of JSON                       | total encoded size of one value                                                                                                                       | `value-too-large` |
| `recycleAboveBytes`      | 48 MiB of linear memory             | an instance that grew past it is dropped after the run (memory never shrinks)                                                                         |                   |
| hard backstop (not here) | `RECOMMENDED_HARD_TIMEOUT_MS`, 10 s | the regen worker's watchdog terminates and recycles the worker (T7.2c); the only bound on the residual cases below                                    |                   |

**After a fatal error the instance is dropped**, not reused: out of memory, a thrown `null` (QuickJS throws it when some allocations fail and the runtime can be corrupt afterwards, T7.0c), a wasm trap, or a host stack overflow escaping the interpreter. Nothing in it is touched again, not even to dispose, and the next run makes a new instance. `stats.recycled` says when this happened.

**Measured in Node** (this package's tests and a probe on 2026-10-04, 300 ms limit, three runs each): an empty loop stopped 0.3 to 4.1 ms late; loops of `slice().sort()` on 20,000 numbers 1 to 6.5 ms, of `JSON.parse(JSON.stringify(...))` on 500 objects 1.6 to 2.4 ms, of `indexOf` on a 1 MB string 0.8 to 1.5 ms, of spreading a 1,000,000-element array 38 ms. Allocation bombs end at the heap cap in 2 to 190 ms. The 100,000-call cap is reached in well under the time limit.

**Builtin guards and the tolerance.** QuickJS polls its interrupt handler on a counter of bytecode branches and calls (every 10,000), not on time, so a loop whose body is one expensive native call overran a 100 ms deadline by 8 to 12 s in T7.0c. The prelude therefore wraps the heavy builtins (`Array.prototype` `sort`, `toSorted`, `join`, `slice`, `concat`, `splice`, `fill`, `flat` (charged by every slot it will walk, nested arrays included), `flatMap` (charged by the length of every callback result it flattens), `indexOf`, `includes` and the like, the callback methods `forEach`, `map`, `filter`, `some`, `every`, `reduce` and `reduceRight` (charged by the receiver's length: they skip holes natively, so on a sparse array no callback runs and nothing was counted; a security audit measured a loop of `some` over `new Array(1e5)` running 6.4 s past a 300 ms limit, `forEach` 6.3 s, `map` 3.3 s; `find`, `findIndex`, `findLast` and `findLastIndex` call their callback for holes too, so the interrupt handler sees them unguarded; 100,000 rounds of `map`, `filter`, `forEach`, `reduce`, `some` and `every` on an 8-element array take about 0.55 s against 0.3 s unguarded), the same on typed arrays, `String.prototype` search, split, replace, repeat and padding, `JSON.stringify` and `JSON.parse`, `Object.keys`/`values`/`entries`/`assign`/`getOwnPropertyNames`/`getOwnPropertyDescriptors`/`getOwnPropertySymbols`/`freeze`/`seal`, `Reflect.ownKeys`, `Array.from`, `localeCompare`, `isWellFormed`, `toWellFormed`, the URI functions and `escape`/`unescape`, the typed array constructors (charged by the size or length of their argument) and their `from`/`of`, and the array iterators behind spread; a security review found a loop of `Reflect.ownKeys` on a 1,000,000-element array running 222 s past a 300 ms limit before these were added). Each charges its input sizes, and the size of a string, array, typed array or buffer it returns, to a budget (any other result costs nothing: it is usually a value the script passed in, like the element `shift()` returns) and asks the host for the time every 100,000 units, then refuses to run once time is up. Sizes are read without running any script code: a string's length, a genuine array's `length` (an own data property), a typed array's or buffer's length, a `Map`'s or `Set`'s size and a `RegExp`'s source length, through the internal-slot getters captured before the script runs (the getter is picked by prototype chain, so sizing an ordinary object throws nothing). Every `Proxy` the script makes is recorded (the `Proxy` constructor is wrapped), so no trap or getter is ever called to size a value. Anything else that is an object (plain objects, generic array-likes, accessor `length`s, proxies) cannot be sized honestly, so a call on it reads the clock every time: `freeze`, `seal`, `assign`, `getOwnPropertyDescriptors`, `defineProperties` and the like on plain objects are bounded that way rather than by key count (a security re-audit found `getOwnPropertyDescriptors` on a 100,000-key object running 10.4 s late when only `length` counted, and a later round found a huge Proxy `ownKeys` result being read by the size estimate itself). Every wrapper checks whether the run is already stopped before doing anything else. `Function.prototype.apply`, `Reflect.apply` and `Reflect.construct` are charged by the length of their argument list. Every guarded call also costs at least 1,000 units, so the time is read at least every 100 guarded calls whatever the estimate says. Also guarded (T7.2e): `Map` `get`, `has`, `set`, `delete`, `getOrInsert` and `getOrInsertComputed` and `Set` `has`, `add` and `delete`, charged by a string key's length when it is over 256 characters (other keys cost nothing, so these lean wrappers read no clock; a loop of `m.has(k)` with a 1 MB key ran 3.9 s past a 300 ms limit before), `Object.is` on two strings of equal length (0.7 s late), `Map.groupBy`, `Set.groupBy` and `Object.groupBy` (they insert keys internally, past the guarded `set`; the callback is wrapped so a long string key is charged by its length and an object key, which `Object.groupBy` converts natively, reads the clock: a loop of `Map.groupBy` over 1,000 elements with a 1 MB key ran 5.7 s late), the set methods (`union`, `intersection`, `difference`, `symmetricDifference`, `isSubsetOf`, `isSupersetOf`, `isDisjointFrom`, charged by both sizes plus the total length of the long string keys ever added to either Set, which a result inherits: a loop of `union` on a Set of 40 keys of 1 MB ran 4.8 s late; an argument that is not a plain `Set` with the installed `size`, `has` and `keys` (any set-like, a subclass, or any Set after `Set.prototype.keys` or the Set iterator's `next` is replaced) has its `size`, `has` and `keys` read once by the wrapper, as the method itself would, and the method gets a record whose `keys()` iterator charges every long string key it yields), and `ArrayBuffer` (constructor, `transfer`, `transferToFixedLength`, `resize`, charged by the length asked for; a length that is not a number reads the clock, since its conversion is native). Also guarded: `Object.defineProperties`, `Object.create`, `isFrozen`, `isSealed`, `String.raw` (charged by its `raw` length), `ArrayBuffer.prototype.slice` (by byte length), and every iterator factory (`values`, `keys`, `entries` and `Symbol.iterator` on arrays, typed arrays, `Map` and `Set`, and `String.prototype[Symbol.iterator]`; `Set.prototype.keys === Set.prototype.values` still holds), charged at creation because spreading an iterator is a native loop (`[...a.keys()]` on 1,000,000 elements ran 92.8 s late before, and `[...s]` on a 1 MB string 210 s late). A fourth security round added `RegExp` (called or constructed, charged by the pattern's length; also `RegExp.prototype.compile`), `Number` (called or constructed; charged by a string's length, and at the 1,000-unit minimum for an object, whose conversion runs script code the interrupt handler sees or a guarded `toString`), `parseFloat` and `parseInt` (also reached as `Number.parseFloat` and `Number.parseInt`, still the same functions), `Array.prototype.shift` and `unshift`, and `String.prototype` `startsWith`, `endsWith`, `match`, `matchAll` and `search` (the last three compile a string pattern into a regular expression); before them, a loop of `new RegExp` over a 1 MB pattern ran 41 s late, of `Number` or `parseFloat` over a 1 MB string 5 s, of `unshift`/`shift` on 1,000,000 elements 6 s. `Number`, `RegExp` and `Proxy` keep their statics, `instanceof`, subclassing and `constructor` properties, and `RegExp(r) === r` still holds; `Proxy` has no `prototype` property, as in ECMAScript. Regular expression literals are compiled once with the source (bounded by `MAX_SOURCE_LENGTH`), not on each evaluation, and matching (`exec`, `test`) polls the interrupt handler itself. So the documented tolerance is **one guarded builtin call past the deadline**: a few ms on ordinary data, at most one call on data near the heap cap (one `sort()` of millions of elements can take seconds). The cost is about 0.5 to 1.5 µs per guarded call on sizable data (100,000 `indexOf` calls on a 3-element array: 140 ms in the test suite's engine, against a few ms for plain indexing; 100,000 `q.push({ i }); q.shift()` pairs: 195 ms; 20,000 `'a,b,c'.split(/,/)`: 88 ms; 100,000 `Number(o)` with a `valueOf`: 40 ms). A call whose receiver or argument is an object that cannot be sized (a plain object, generic array-like or proxy, as in `Object.keys(o)` or `Object.assign(t, o)`) reads the clock every time, about 5 µs per call (100,000 `Object.keys` on a two-key object: 500 ms); such loops are rare in model scripts, and the price is what bounds them.

**Residual cases** bounded only by the heap cap and the regen worker's watchdog (T7.2c), the only bound for anything not listed here: a single generic call over a fake huge length (`Array.prototype.indexOf.call({ length: 1e12 }, 1)` is one native loop; loops of such calls stop within one call of the deadline, but one call does not stop), a single callback method call on a genuine huge sparse array (`new Array(2 ** 32 - 1).some(f)` is charged once by its length, then walks about 4.3 billion holes natively with no callback, so that one call is bounded only by the 10 s watchdog), a single call reading a huge Proxy `ownKeys` result (QuickJS checks it for duplicates superlinearly: 30,000 keys took 0.1 s), native loops behind syntax that cannot be wrapped, chiefly object spread and rest (`{ ...big }`) and `for...in` over objects with tens of thousands of keys (a loop copying a 10,000-key object overran by 4.9 s), `BigInt` arithmetic and `toString` on huge BigInts, operators on huge strings (unary `+s` and other implicit number conversions, measured 10.8 s late for a loop over a 1 MB string with a 300 ms limit, and `===`, `<` and friends comparing two equal 1 MB strings, 1.7 s late; operators cannot be wrapped), the string an object's `valueOf`/`toString` returns to `Number(object)` (parsed natively and not charged; only the call is), one `flat(Infinity)` call over a shared deep chain of arrays (the walk that prices it stops at 256 slots and charges one clock read, so that one call is not stopped; a loop of them is), one `flat` call whose elements are getters (the getter's result is flattened but not charged in that call), plus any builtin not in the list above. T7.2e's findings are listed below.

## Determinism

The same source, parameters, seed and host answers give the same result in every run, every fresh instance and every browser (every browser runs the same `.wasm`, so `Math.sin` and number formatting give the same bits, T7.0c):

- `Date` is not created (the context's `Date` intrinsic is off). There are no timers, `WeakRef`, `FinalizationRegistry`, `Atomics`, `SharedArrayBuffer` (deleted) or host objects.
- `Math.random` is mulberry32 seeded by `randomSeed(source, seed)`: FNV-1a of the script source as stored, mixed with the feature's integer `seed`. Never the feature id, which sync and merges rename (ADR 0009 decision 5). Changing the source, even a comment, changes the sequence.
- `eval`, the `Function` constructor and the generator and async function constructors throw: there is no code generation.
- Every run gets a fresh context, so nothing a run leaves on the global object or on a prototype is seen by the next.
- NaN crosses canonically; the build has no SIMD, no threads and no shared memory.
- A scripted feature's cache key (T7.2c) hashes the source, the evaluated parameters, the seed, the API version and `QUICKJS_BUILD`, besides what ADR 0004 decision 8 lists.

## API versions

A script is stamped with the script API version it was written against (stored with it in the document, T7.2a; new scripts get `CURRENT_SCRIPT_API_VERSION`, today 1) and may also declare it with `export const apiVersion`. **The promise: a script written against a version runs unchanged, with the same results, in every later build** (ADR 0010 decision 9, the same promise the file format makes). A version covers this package's side (globals, shims, value rules, script shape, declaration fields) and the `ctx` API regen hands to `run`, which T7.2c picks by the same number.

- Within a version only additions that cannot change what an existing script sees are allowed (a new `ctx` function is one; a changed result, a removed function or a new global that could shadow a script's own name is not). Anything else is a new version, and the old one stays: `SCRIPT_API_VERSIONS` only grows.
- A build refuses versions it does not know before running anything, with `api-version` and a message saying which versions it runs and that a newer manufakture is needed. A declared version that differs from the stamp is refused too.
- Whether scripts from other people's documents run on open is app policy (T7.2d), gated on the human security sign-off (T7.6b); this package runs what it is given.

## Security model

A script is untrusted code. It sees ECMAScript built-ins (minus the ones above) and exactly the functions in the host API it is handed as `ctx`, nothing else: the global object holds only the standard names (the test suite pins the exact list), and there is no `fetch`, storage, DOM, worker messaging, module loading or clock.

- **The binding is the attack surface.** Values cross as JSON. The in-sandbox glue (`prelude.ts`) encodes them with the limits above, but the host never trusts it: `codec.ts` checks the size and nesting depth of every payload before parsing, refuses `__proto__` keys and malformed markers, resolves handle markers only against the current run's table, and counts elements and string lengths again. A script that tampers with prototypes can only change how its own data is encoded; a handle marker forged in the encoded JSON (possible with a `Proxy` that hides the marker key from the glue's check) resolves only to a handle issued earlier in the same run, and out-of-range, negative or fractional indices are refused (tested). Host prototypes are never touched (results are built by the host's `JSON.parse` and validated).
- **Memory isolation.** Each document gets its own module instance and linear memory, so an interpreter memory-safety bug in one document's script cannot read another document's heap (ADR 0010 decision 4). Runtimes of one instance would share memory; there is one runtime per instance.
- **Availability.** The limits above end runaway scripts as feature errors; an instance whose runtime may be corrupt is dropped; the worker watchdog is the last resort.
- The QuickJS interpreter has not been audited (its README says so). `src/hostile.test.ts` (T7.2e) fuzzes the binding with hostile values; the security review (T7.6a, T7.6b) covers this package through it.
- **Worker policy.** The regen worker, where scripts run, is served with `connect-src 'self'` (`apps/web/src/hosting/headers.ts`, `docs/hosting.md`), so even a script that escaped the interpreter could not send data to another origin. `apps/web/e2e/scripting-cross-browser.spec.ts` checks that in every browser, with a control worker served without the policy.

## Hardening findings (T7.2e)

Evidence for the security review (T7.6a). The hard bound on any run is the regen worker's 10 s watchdog (worker termination, T7.2c); a residual below means a soft-limit overrun of at most one call, or a loop the watchdog ends, never an unbounded cost.

**The binding fuzz** (`src/hostile.test.ts`). 300 seeded scripts (seed per case, reproducible) pass combinations of proxies (throwing, duplicate-key and revoked ones, ones forging a handle marker), getters (throwing, throwing `null`, mutating siblings, returning 2 MiB strings), cycles, values just over and under every size limit, NaN with payloads, `__proto__`, `constructor` and marker keys, symbols, BigInts, functions, class instances, `Map`s, typed arrays, and `run`'s own `ctx`, after up to two prototype-pollution steps (`toJSON` on `Object.prototype` and `Array.prototype`, a marker or `kind` key on `Object.prototype`, replaced `JSON`, `Object.getPrototypeOf`, `Reflect.apply`, `Array.isArray`, `WeakMap`/`Map`/`WeakSet` methods, `Function.prototype.call`/`apply`/`bind`, frozen prototypes, an `Object.prototype.value` getter, an index getter on `Array.prototype`). Checked on every case: the run resolves with a typed outcome and never `host-error`; every value a host function receives and every result is host-built plain data (host prototypes, data properties only, no holes, no `__proto__`, marker or symbol keys, sizes in the limits, handles only from the same run); NaN arrives canonical; the instance runs a canary correctly afterwards; every eighth case gives the same outcome bit for bit in a fresh instance; the host's intrinsic prototypes are unchanged at the end. Tampering ends a run as `runtime`, `value-too-large` or `internal` (a call the glue could no longer form). A mutation fuzz feeds 5,000 random and corrupted payloads to `decodePayload` directly: each gives valid data or a `CodecError`, nothing else.

**Fixed:**

- `Map`/`Set` lookups with huge string keys (including this build's `Map.prototype.getOrInsert` and `getOrInsertComputed`, about 3.7 s late, found in review) and `Object.is` on equal huge strings overran the time limit by 3.9 s and 0.7 s in a loop (guarded, above).
- `Map.groupBy`, `Set.groupBy` and `Object.groupBy` inserted keys internally: one call over 100,000 elements with a 1 MB key ran 5.9 s past a 300 ms limit, a loop over 1,000 elements 5.7 s (security audit; guarded, above). An earlier draft of this list wrongly had `Map.groupBy` as checked: the probe then used a small key.
- The set methods hash every element, so a Set of 40 keys of 1 MB made a loop of `union` 4.8 s late although its size is 40 (charged by key weight now).
- A set-like argument (own `keys()` iterator) to `union`, `difference` or `symmetricDifference` had every yielded key hashed natively, uncharged: loops with a 1 MB key ran 2.8, 2.7 and 5.7 s late, and one `union` with a 4 MB key 11.9 s (re-audit). The yielded keys are now charged through a wrapping record (above); `intersection`, `isSupersetOf` and `isDisjointFrom` drain `keys()` the same way and go through it too, and the `has()` path is script code asked about this Set's own, already weighed keys. A Set subclass overriding `keys` and a replaced `Set.prototype.keys` take the same path (tested). The wrapper follows GetSetRecord's order (`size` read and checked, `TypeError` for NaN and `RangeError` for negative, before `has` and `keys`) and forwards `return()`, so a set-like's iterator is closed when `isDisjointFrom` or `isSupersetOf` stops early; both checked against Node's native set methods (review round 3).
- A replaced Set iterator `next` (on the prototype of `new Set().values()`) made plain Sets take the native path while the method drained the script's `next` uncharged: a loop ran 2.5 s late, one `union` yielding a 4 MB key 3,000 times 8.6 s (security re-audit). The plain-Set test now also requires the original `next`. Paths of the same shape were checked and stop on time, since every key they insert goes through a guarded `add`/`set` or the wrapped `groupBy` callback whatever iterator produced it: `Map.groupBy`, `new Set` and `new Map` from an array, `Array.from` and spread into a Set, each after the Array iterator's `next` is replaced (tested).
- The set methods and `ArrayBuffer` allocation, transfer and resize were native loops outside the guards (0.2 s late in a loop; guarded). `new ArrayBuffer('32000000')` (a string length) is priced at a clock read.
- `encodeValue` walked a host array before checking its length: a host function returning `new Array(1e9)` would have been encoded as gigabytes of `null`s. Now refused by length first.
- A parameter named `__proto__` passed the identifier check: `resolveParams` would have set the prototype of the params object instead of a key (the codec then refused it, so it was a confusing error rather than an escape). Now refused as `bad-declaration`, and `resolveParams` defines keys instead of assigning them.
- The worker scripts' `connect-src` allowed any `https:` origin; now `'self'`.

**Scan.** Every function left native on `Map`, `Set`, `WeakMap`, `WeakSet`, `Object`, `Array`, `String`, `Reflect`, `Symbol`, `ArrayBuffer`, typed arrays, `Iterator` and `RegExp` (and their prototypes) in this build was listed and checked for internal key insertion or native loops; the ones above were the finds. A QuickJS update must repeat this scan.

**Checked, no change needed:** `Object.freeze`, `seal`, `isFrozen` and `preventExtensions` on 100,000-key objects and arrays stop within one call (plain objects read the clock on every call); typed-array subclasses go through the guarded constructors and `from` (tested); `Set` iteration is charged at iterator creation, so spreads, `Array.from` and `new Set(set)` stop on time; `Symbol.for`, `Symbol.keyFor`, `hasOwnProperty`, `Object.hasOwn`, `Reflect.get`, `Object.defineProperty`, `Object.fromEntries` and `in` with a 1 MB key, and `new Map`/`new Set` from many huge keys (they call the guarded `set`/`add`), stop on time; `WeakMap` and `WeakSet` methods take object keys only (constant time); iterator helpers (`toArray`, `drop`), `Error` with a huge message and `String.prototype` `slice`, `substring` and `at` stop on time.

**Accepted residuals** (each bounded by the watchdog): the one-call cases listed under Limits above; operators on huge strings; object spread and `for...in` over huge objects; huge `BigInt` arithmetic.

**Regen-side items from the T7.2b and T7.2c reviews** (in `packages/regen` and `packages/core`, outside this package; recorded here for T7.6a):

- _Runaway and session-fatal state is per worker._ The runaway set lives in `RegenClient` on the main thread and is handed to every new worker, so a watchdog restart never loops. The session-fatal set lives in the worker's `ScriptHost` and is lost on a watchdog restart; the cost is at most one more kernel recycle for that feature in the new worker, after which it is remembered again. Accepted: bounded, and a restart is already the rare path.
- _A non-script fatal can pin a feature._ A kernel trap during a scripted feature's session (an OCCT bug or memory exhaustion caused by earlier features) marks that feature's cache key session-fatal, and it fails until an edit changes the key or the worker restarts. Accepted: it fails closed (no loop of recycles), and any edit or a reload clears it.
- _Operation id length._ `SCRIPT_OPERATION_ID_PATTERN` and `scriptOperationOf` cap an operation id at 64 characters; core's `parseName` reads the operation segment without that cap. Accepted: the segment is kept as text either way and cannot contain a feature id head (no `#`), so a longer id in a crafted name parses to the same parts, and scripts cannot make one (the regen API refuses it).

## TypeScript

`prepareSource` refuses sources longer than `MAX_SOURCE_LENGTH` (256 Ki UTF-16 units, `value-too-large`) before sucrase sees them, as defence in depth behind core's limit on stored scripts. `prepareSource(source, 'ts')` erases types with sucrase (`typescript` transform, `disableESTransforms`). Before erasing it refuses `namespace` and `module` blocks and `import x = require()` / import aliases, which sucrase would drop silently (ambient `declare namespace` and `declare module` are fine). After erasing it refuses any remaining `import` (type-only imports are erased first, so `import type { Ctx } from 'manufakture'` for editor typings works). `enum` and parameter properties are compiled by sucrase and work.

Sucrase keeps every line but **does not keep columns**: it deletes annotations rather than blanking them (T7.0c's write-up said both tools keep columns; for sucrase that holds only on lines without annotations). Error positions are therefore mapped back through the source map sucrase emits, one segment per token; tests check that a mapped position points at the same character as the equivalent JavaScript error.

## Errors

`ScriptError { code, message, line?, column?, stack? }`, positions 1-based in the source as written. Codes: `timeout`, `heap-limit`, `stack-limit`, `op-limit`, `call-limit`, `value-too-large` (the limits, `LIMIT_CODES`), `syntax`, `unsupported-syntax`, `api-version`, `bad-declaration`, `bad-param`, `runtime` (the script threw, or passed a value that cannot cross), `host-error` (a host function failed or returned something that cannot cross) and `internal`. `stack` is the script's backtrace with positions mapped, repeated frames folded and at most 20 lines.

## Tests

`pnpm --filter @manufakture/script test` (part of the root `make test`, about 30 s; `src/hostile.test.ts` is the T7.2e fuzz and hardening suite): every limit (infinite loop, a loop that catches everything, builtin loops, slow host functions, deep recursion, four kinds of allocation bomb, huge values both ways, call and operation caps), the global surface and escape attempts (`Function('return this')()`, constructor chains, `eval`, prototype tampering, `__proto__` in results, forged handles), determinism across runs and instances and independence from the feature id, separate instances per document, recycling after a fatal error, TypeScript erasure and position mapping, declarations and parameter resolution, and hostile payloads fed to the host codec directly.
