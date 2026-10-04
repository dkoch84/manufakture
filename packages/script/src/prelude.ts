// The code the host evaluates in every fresh context before the script (ADR 0010 decision 3). It
// is a function expression; the host calls it with four raw host functions and a JSON config, and
// keeps the object it returns. Nothing it defines is put on the global object, so the script can
// reach none of it except the frozen `ctx` it is handed and the shims below.
//
// What it does:
// - `Math.random` becomes mulberry32 over a 32-bit seed the host derives from the source hash and
//   the feature's `seed` (never the feature id).
// - `eval`, the `Function` constructor and the generator and async function constructors are
//   replaced by functions that throw, so a script has no code generation (its positions would
//   map to nothing, and it is not needed). `x instanceof Function` keeps working.
//   `SharedArrayBuffer` is deleted (there are no threads behind it).
// - Builtins whose single call can do a lot of native work (sort, join, slice, JSON, string
//   search and padding, and similar) are wrapped in a guard that charges the work to a budget and
//   asks the host for the time every `TICK_WORK` units, then refuses to run once time is up. QuickJS
//   polls its interrupt handler only every 10,000 bytecode branches or calls, so without this a
//   loop of `a.sort()` overran a 100 ms deadline by 8 to 12 s (T7.0c). With it, a loop of guarded
//   builtins stops within one builtin call of the deadline.
// - Values cross the boundary as JSON written with a replacer that enforces the value limits,
//   carries NaN, infinities and -0 as markers (JSON would turn them into null and 0) and turns
//   handles into markers. Handles are frozen objects whose index lives in a WeakMap here, out of the
//   script's reach.
//
// Security does not rest on this file: the host validates every payload it receives as untrusted
// (`codec.ts`). A script that tampers with prototypes before calling the API can at worst change
// how its own data is encoded, and forging a handle marker can only name a handle the same run was
// already given. The intrinsics used here are captured before the script runs, so ordinary
// prototype changes in a script do not break the glue.

/** Work units (roughly element operations) between two time checks in the builtin guards. */
export const TICK_WORK = 100_000;

/** Key of the marker objects in payloads; the host refuses it in any other object. */
export const MARK = '\u0000mfk';

/** File name of the prelude in backtraces; frames from it are dropped from user-facing stacks. */
export const PRELUDE_FILENAME = 'mfk:prelude';

export interface PreludeConfig {
  seed: number;
  mark: string;
  tickWork: number;
  maxStringLength: number;
  maxElements: number;
  maxDepth: number;
  maxPayloadLength: number;
  /** The host API's shape: `1` for a function, an object for a namespace. */
  api: ApiShape;
}

export interface ApiShape {
  [name: string]: 1 | ApiShape;
}

export const PRELUDE_SOURCE = String.raw`(function setup(hostCall, hostTick, hostAbort, configJson) {
  'use strict';
  const G = globalThis;
  const ObjectCreate = Object.create;
  const freeze = Object.freeze;
  const defineProperty = Object.defineProperty;
  const getPrototypeOf = Object.getPrototypeOf;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const ObjectKeys = Object.keys;
  const ObjectProto = Object.prototype;
  const hasOwn = Object.prototype.hasOwnProperty;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const isArray = Array.isArray;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const WeakMapC = WeakMap;
  const WeakSetC = WeakSet;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const MapC = Map;
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const TypeErr = TypeError;
  const RangeErr = RangeError;
  const ErrorC = Error;
  const PromiseC = Promise;
  const StringC = String;
  const imul = Math.imul;
  const clz32 = Math.clz32;

  const config = parse(configJson);
  const MARK = config.mark;
  const TICK_WORK = config.tickWork;
  const maxString = config.maxStringLength;
  const maxElements = config.maxElements;
  const maxDepth = config.maxDepth;
  const maxPayload = config.maxPayloadLength;

  // ---- seeded Math.random (mulberry32)
  let state = config.seed | 0;
  defineProperty(Math, 'random', {
    value: function random() {
      state = (state + 0x6d2b79f5) | 0;
      let t = imul(state ^ (state >>> 15), 1 | state);
      t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    writable: true, enumerable: false, configurable: true,
  });

  // ---- no code generation, no shared memory
  const refusing = (name, what) => {
    const f = function () { throw new TypeErr(what + ' is not available in scripts'); };
    defineProperty(f, 'name', { value: name });
    return f;
  };
  const replaceConstructor = (proto, name) => {
    const fake = refusing(name, 'The ' + name + ' constructor');
    defineProperty(fake, 'prototype', { value: proto, writable: false, enumerable: false, configurable: false });
    defineProperty(proto, 'constructor', { value: fake, writable: false, enumerable: false, configurable: false });
    return fake;
  };
  const FakeFunction = replaceConstructor(getPrototypeOf(function () {}), 'Function');
  replaceConstructor(getPrototypeOf(function* () {}), 'GeneratorFunction');
  replaceConstructor(getPrototypeOf(async function () {}), 'AsyncFunction');
  replaceConstructor(getPrototypeOf(async function* () {}), 'AsyncGeneratorFunction');
  defineProperty(G, 'Function', { value: FakeFunction, writable: true, enumerable: false, configurable: true });
  defineProperty(G, 'eval', { value: refusing('eval', 'eval'), writable: true, enumerable: false, configurable: true });
  delete G.SharedArrayBuffer;

  // ---- time guards on heavy builtins
  let budget = TICK_WORK;
  let stopped = false;
  const stopNow = () => {
    stopped = true;
    throw new ErrorC('The script was stopped');
  };
  const charge = (work) => {
    if (stopped) stopNow();
    budget -= work;
    if (budget <= 0) {
      budget = TICK_WORK;
      if (hostTick()) stopNow();
    }
  };

  // Every Proxy the script makes is recorded here (the Proxy constructor is wrapped below), so the
  // size estimate can tell proxies apart without calling any of their traps.
  const OrigProxy = Proxy;
  const proxies = new WeakSetC();
  const wsAdd = WeakSet.prototype.add;
  const wsHas = WeakSet.prototype.has;
  // Bound once here, so the hot size checks allocate no argument list (Reflect.apply did).
  const isProxy = apply(Function.prototype.bind, wsHas, [proxies]);
  // A bound function is a constructor without a prototype property, like the real Proxy
  // (an ordinary function's prototype property cannot be deleted).
  const bind = Function.prototype.bind;
  const ProxyWrapper = apply(bind, function Proxy(target, handler) {
    if (new.target === undefined) throw new TypeErr('Constructor Proxy requires new');
    const p = new OrigProxy(target, handler);
    apply(wsAdd, proxies, [p]);
    return p;
  }, [undefined]);
  defineProperty(ProxyWrapper, 'name', { value: 'Proxy' });
  const origRevocable = OrigProxy.revocable;
  defineProperty(ProxyWrapper, 'revocable', {
    value: {
      revocable(target, handler) {
        const r = apply(origRevocable, OrigProxy, [target, handler]);
        apply(wsAdd, proxies, [r.proxy]);
        return r;
      },
    }.revocable,
    writable: true, enumerable: false, configurable: true,
  });
  defineProperty(G, 'Proxy', { value: ProxyWrapper, writable: true, enumerable: false, configurable: true });

  // Getters that read internal slots and throw on anything else (a Proxy included), so reading a
  // size through them runs no script code.
  const getter = (proto, key) => getOwnPropertyDescriptor(proto, key).get;
  const TypedArrayProto = getPrototypeOf(Int8Array.prototype);
  const taLength = getter(TypedArrayProto, 'length');
  const bufferLength = getter(ArrayBuffer.prototype, 'byteLength');
  const mapSize = getter(Map.prototype, 'size');
  const setSize = getter(Set.prototype, 'size');
  const regExpSource = getter(RegExp.prototype, 'source');
  const isView = ArrayBuffer.isView;
  // Which slot getter can size an object, found from its prototype chain (no script code runs:
  // the object itself is ruled out as a proxy before this is called, and each prototype is
  // checked before its own prototype is read, so a proxy in the chain is never asked for its
  // prototype and its getPrototypeOf trap cannot run, and change a value already sized, in the
  // middle of a guard; such an object is not sized). Trying every getter in turn instead threw a
  // TypeError per miss, and building those errors made a call with a plain object argument
  // about 3 us slower. A prototype changed to mislead this only makes the getter throw (slot
  // returns -1). A long chain is not walked: past 8 levels the object is not sized.
  const sizers = new MapC();
  apply(mapSet, sizers, [ArrayBuffer.prototype, bufferLength]);
  apply(mapSet, sizers, [Map.prototype, mapSize]);
  apply(mapSet, sizers, [Set.prototype, setSize]);
  apply(mapSet, sizers, [RegExp.prototype, 0]);
  const sizerOf = (x) => {
    let p = getPrototypeOf(x);
    for (let i = 0; i < 8 && p !== null; i++) {
      if (apply(wsHas, proxies, [p])) return undefined;
      const g = apply(mapGet, sizers, [p]);
      if (g !== undefined) return g;
      if (p === ObjectProto) return undefined;
      p = getPrototypeOf(p);
    }
    return undefined;
  };
  const slot = (get, x) => {
    try {
      return apply(get, x, []);
    } catch (e) {
      return -1;
    }
  };
  // Work estimate of a value, read without calling any script code: a string's length, a genuine
  // array's length (always an own, non-configurable data property, so reading it directly from a
  // genuine array that is not a proxy runs nothing; faster than reading its descriptor), a typed
  // array's or buffer's length, a Map's or Set's size, a RegExp's source length. Anything else
  // that is an object (plain objects, array-likes, accessor lengths, proxies) cannot be sized
  // without running its code, so it costs UNTRUSTED: the time is read on every such call.
  // Functions cost nothing (callbacks; any work they do is script code).
  const UNTRUSTED = TICK_WORK;
  const sizeOf = (x) => {
    if (typeof x === 'string') return x.length;
    if (x === null || typeof x !== 'object') return 0;
    if (isProxy(x)) return UNTRUSTED;
    if (isArray(x)) return x.length;
    let n = -1;
    if (isView(x)) {
      n = slot(taLength, x);
    } else {
      const g = sizerOf(x);
      if (g === 0) {
        const source = slot(regExpSource, x);
        if (typeof source === 'string') n = source.length;
      } else if (g !== undefined) {
        n = slot(g, x);
      }
    }
    return n < 0 ? UNTRUSTED : n;
  };
  // Size of a builtin's result: only strings, genuine arrays, typed arrays and buffers, the
  // results a builtin can make big in one call, are charged. Any other result (often a value the
  // script passed in, like the element shift() returns) costs nothing: charging UNTRUSTED for it
  // made every call returning a plain object read the clock. The input side still bounds work.
  const resultSize = (x) => {
    if (typeof x === 'string') return x.length;
    if (x === null || typeof x !== 'object') return 0;
    if (isProxy(x)) return 0;
    if (isArray(x)) return x.length;
    let n = -1;
    if (isView(x)) n = slot(taLength, x);
    else if (sizerOf(x) === bufferLength) n = slot(bufferLength, x);
    return n < 0 ? 0 : n;
  };
  // Every guarded call costs at least this, so the time is read at least every 100 calls even
  // when the size estimate misses the real work.
  const MIN_CHARGE = TICK_WORK / 100;
  const defaultCost = (self, args) => sizeOf(self) + sizeOf(args[0]) + sizeOf(args[1]);
  // Methods that make their result with ArraySpeciesCreate. A script can point the species at a
  // constructor that returns a plain object, which resultSize prices at 0 although the builtin
  // filled it element by element; a fresh result of these methods that is not a genuine array
  // (a proxy included) therefore costs UNTRUSTED. Their ordinary results are genuine arrays, so
  // ordinary calls pay nothing extra.
  const speciesResultSize = (x) => {
    if (x === null || typeof x !== 'object' || isProxy(x) || !isArray(x)) return UNTRUSTED;
    return x.length;
  };
  const guard = (obj, names, sorting, cost, species) => {
    for (const name of names) {
      const d = getOwnPropertyDescriptor(obj, name);
      if (d === undefined || typeof d.value !== 'function') continue;
      const orig = d.value;
      const wrapper = {
        [name](...args) {
          if (stopped) stopNow();
          let n = cost === undefined ? defaultCost(this, args) : cost(this, args);
          if (sorting && n > 1 && n < UNTRUSTED) n = n * (32 - clz32(n));
          charge(n + MIN_CHARGE);
          const result = apply(orig, this, args);
          charge(species ? speciesResultSize(result) : resultSize(result));
          return result;
        },
      }[name];
      defineProperty(wrapper, 'length', { value: orig.length });
      defineProperty(obj, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
    }
  };
  guard(Array.prototype, ['copyWithin', 'fill', 'includes', 'indexOf', 'join', 'lastIndexOf',
    'reverse', 'toReversed', 'toSpliced', 'with', 'toString', 'toLocaleString', 'shift',
    'unshift'], false);
  guard(Array.prototype, ['slice', 'splice'], false, undefined, true);
  // The callback methods skip holes natively: on a sparse array no callback runs, so neither the
  // budget nor the interrupt counter moved (a loop of some() over new Array(1e5) ran 6.4 s past a
  // 300 ms limit). They are charged by the receiver's length only: the callback costs nothing
  // (its work is script code), and a thisArg or reduce's initial value is often a plain object,
  // which would read the clock on every call. find, findIndex, findLast and findLastIndex call
  // the callback for holes too, so the interrupt handler already sees their loops. These are
  // called often on small arrays, so their wrapper is a lean one (no rest parameter; only the
  // species methods price their result): 500,000 calls on an 8-element array cost about 0.25 s.
  for (const name of ['forEach', 'some', 'every', 'reduce', 'reduceRight', 'map', 'filter']) {
    const d = getOwnPropertyDescriptor(Array.prototype, name);
    const orig = d.value;
    const species = name === 'map' || name === 'filter';
    const wrapper = {
      [name]() {
        if (stopped) stopNow();
        charge(sizeOf(this) + MIN_CHARGE);
        const result = apply(orig, this, arguments);
        if (species) charge(speciesResultSize(result));
        return result;
      },
    }[name];
    defineProperty(wrapper, 'length', { value: orig.length });
    defineProperty(Array.prototype, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  }
  // concat copies every spreadable argument, not just the first two.
  guard(Array.prototype, ['concat'], false, (self, args) => {
    let n = sizeOf(self);
    for (let i = 0; i < args.length; i++) n += sizeOf(args[i]);
    return n;
  }, true);

  // flat walks every slot of every nested array down to its depth, holes included, so its cost
  // is the sum of the lengths it will walk, read without running script code: own data
  // properties of genuine arrays, and for a hole the prototype chain's own properties. Charging
  // only the outer length let a loop of flat() over 100 references to one 100,000-slot array run
  // 12.8 s past a 200 ms limit. What cannot be read that way (an accessor, a proxy, a depth that
  // is not a number) costs UNTRUSTED (a non-number depth is treated as unbounded, so it can only
  // overcharge), and so does a walk past FLAT_STEPS slots: a cost of
  // UNTRUSTED or more already reads the clock, so walking further would only add time.
  const FLAT_STEPS = 256;
  const flatCost = (self, args) => {
    if (self === null || typeof self !== 'object' || apply(wsHas, proxies, [self]) || !isArray(self)) return sizeOf(self);
    const d0 = args[0];
    const depth = d0 === undefined ? 1 : typeof d0 === 'number' ? (d0 !== d0 ? 0 : d0) : Infinity;
    let total = 0;
    let steps = 0;
    // The value at index i of a genuine array, or undefined for a slot flat skips; throws
    // UNTRUSTED (a number, caught below) when only script code could tell.
    const element = (arr, i) => {
      let d = getOwnPropertyDescriptor(arr, i);
      let p = arr;
      for (let k = 0; d === undefined; k++) {
        p = getPrototypeOf(p);
        if (p === null) return undefined;
        if (k >= 8 || apply(wsHas, proxies, [p])) throw UNTRUSTED;
        d = getOwnPropertyDescriptor(p, i);
      }
      // hasOwn, not 'in': a descriptor inherits from Object.prototype, where a script can put a
      // value (or a getter) that would make an accessor look like data.
      if (!apply(hasOwn, d, ['value'])) throw UNTRUSTED;
      return d.value;
    };
    const walk = (arr, depth) => {
      const len = getOwnPropertyDescriptor(arr, 'length').value;
      total += len + 1;
      if (depth < 1) return;
      for (let i = 0; i < len; i++) {
        if (total >= UNTRUSTED || ++steps > FLAT_STEPS) throw UNTRUSTED;
        const v = element(arr, i);
        if (v === null || typeof v !== 'object') continue;
        if (apply(wsHas, proxies, [v])) throw UNTRUSTED;
        if (isArray(v)) walk(v, depth - 1);
      }
    };
    try {
      walk(self, depth);
    } catch (e) {
      if (e === UNTRUSTED) return UNTRUSTED;
      throw e;
    }
    return total;
  };
  guard(Array.prototype, ['flat'], false, flatCost, true);
  // flatMap flattens each callback result one level: the callback is wrapped so that every
  // result is charged by the length flatMap will walk (a proxy, which flatMap also flattens,
  // costs UNTRUSTED). A callback that is not a function is passed on for flatMap to refuse.
  guard(Array.prototype, ['flatMap'], false, (self, args) => {
    const cb = args[0];
    if (typeof cb === 'function') {
      args[0] = function (v, i, o) {
        const r = apply(cb, this, [v, i, o]);
        if (r !== null && typeof r === 'object') {
          charge(apply(wsHas, proxies, [r]) ? UNTRUSTED : isArray(r) ? getOwnPropertyDescriptor(r, 'length').value : 0);
        }
        return r;
      };
    }
    return sizeOf(self);
  }, true);
  guard(Array.prototype, ['sort', 'toSorted'], true);
  guard(TypedArrayProto, ['copyWithin', 'fill', 'includes', 'indexOf', 'join', 'lastIndexOf',
    'reverse', 'set', 'slice', 'toReversed', 'with', 'toString', 'toLocaleString'], false);
  guard(TypedArrayProto, ['sort', 'toSorted'], true);
  guard(String.prototype, ['concat', 'includes', 'indexOf', 'lastIndexOf', 'normalize', 'padEnd',
    'padStart', 'repeat', 'replace', 'replaceAll', 'split', 'toLowerCase', 'toUpperCase',
    'toLocaleLowerCase', 'toLocaleUpperCase', 'trim', 'trimStart', 'trimEnd', 'localeCompare',
    'isWellFormed', 'toWellFormed', 'startsWith', 'endsWith', 'match', 'matchAll', 'search'], false);
  guard(JSON, ['stringify', 'parse'], false);
  guard(Object, ['keys', 'values', 'entries', 'assign', 'fromEntries', 'getOwnPropertyNames',
    'getOwnPropertyDescriptors', 'getOwnPropertySymbols', 'freeze', 'seal', 'defineProperties',
    'create', 'isFrozen', 'isSealed'], false);
  guard(Reflect, ['ownKeys'], false);
  guard(Array, ['from'], false);
  guard(getPrototypeOf(Int8Array), ['from', 'of'], false);
  guard(G, ['encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape',
    'parseFloat', 'parseInt'], false);
  guard(String, ['raw'], false, (self, args) => {
    const t = args[0];
    if (t === null || typeof t !== 'object') return 0;
    // The template object's raw strings are read by the builtin anyway; a proxy or getter is
    // not touched here.
    if (apply(wsHas, proxies, [t])) return UNTRUSTED;
    const d = getOwnPropertyDescriptor(t, 'raw');
    return d !== undefined && apply(hasOwn, d, ['value']) ? sizeOf(d.value) : UNTRUSTED;
  });
  guard(ArrayBuffer.prototype, ['slice'], false);
  // Calls with an argument list copy it natively: charged by the list's length.
  guard(Function.prototype, ['apply'], false, (self, args) => sizeOf(args[1]));
  guard(Reflect, ['apply'], false, (self, args) => sizeOf(args[2]));
  guard(Reflect, ['construct'], false, (self, args) => sizeOf(args[1]));

  // Iterator factories (values, keys, entries, and Symbol.iterator behind spread and for...of):
  // spreading an iterator is a native loop the interrupt handler never sees ([...a.keys()] on a
  // 1,000,000-element array ran 92.8 s past a 300 ms deadline), so creating one charges the size.
  // A function shared by two names (Set's keys and values) gets one shared wrapper.
  const guardIterators = (proto, names, iteratorName) => {
    const wrapped = new MapC();
    for (const name of names) {
      const d = getOwnPropertyDescriptor(proto, name);
      if (d === undefined || typeof d.value !== 'function') continue;
      const orig = d.value;
      let wrapper = apply(mapGet, wrapped, [orig]);
      if (wrapper === undefined) {
        wrapper = {
          [name]() {
            if (stopped) stopNow();
            charge(sizeOf(this) + MIN_CHARGE);
            return apply(orig, this, []);
          },
        }[name];
        apply(mapSet, wrapped, [orig, wrapper]);
      }
      defineProperty(proto, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
      if (iteratorName !== undefined && name === iteratorName) {
        defineProperty(proto, Symbol.iterator, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
      }
    }
  };
  guardIterators(Array.prototype, ['values', 'keys', 'entries'], 'values');
  guardIterators(TypedArrayProto, ['values', 'keys', 'entries'], 'values');
  guardIterators(Map.prototype, ['entries', 'keys', 'values'], 'entries');
  guardIterators(Set.prototype, ['values', 'keys', 'entries'], 'values');
  // The string iterator is itself the Symbol.iterator entry: no alias to install.
  guardIterators(String.prototype, [Symbol.iterator], undefined);

  // Map and Set hash a string key in full on every lookup, and compare it in full on a hit, so a
  // loop of m.has(k) with a 1 MB key ran 3.9 s past a 300 ms limit (T7.2e). A string key longer
  // than KEY_FREE is charged by its length; every other key is hashed in constant time and costs
  // nothing, so these lean wrappers (called often, on small keys) read no clock. Object.is
  // compares two strings of equal length in full (0.7 s late on 1 MB strings).
  const KEY_FREE = 256;
  // The set methods hash every element of their inputs natively, so a Set holding long string keys
  // costs their total length per call, which its size does not show (a loop of union() on a Set of
  // 40 keys of 1 MB ran 4.8 s late). Each Set records an upper bound on the length of the long
  // keys added to it (deletes are not subtracted: it can only overcharge), and a set method's
  // result inherits its inputs' bound.
  const heavyKeys = new WeakMapC();
  const weightOf = (x) => {
    if (x === null || typeof x !== 'object') return 0;
    const w = apply(wmGet, heavyKeys, [x]);
    return w === undefined ? 0 : w;
  };
  const addWeight = (x, w) => {
    if (w > 0 && x !== null && typeof x === 'object') apply(wmSet, heavyKeys, [x, weightOf(x) + w]);
  };
  const guardKeyed = (proto, names) => {
    for (const name of names) {
      const d = getOwnPropertyDescriptor(proto, name);
      if (d === undefined || typeof d.value !== 'function') continue;
      const orig = d.value;
      const wrapper = {
        [name](key) {
          if (stopped) stopNow();
          if (typeof key === 'string' && key.length > KEY_FREE) {
            charge(key.length);
            if (name === 'add') addWeight(this, key.length);
          }
          return apply(orig, this, arguments);
        },
      }[name];
      defineProperty(wrapper, 'length', { value: orig.length });
      defineProperty(proto, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
    }
  };
  // Maps need no key weight: no Map method hashes another Map's keys in bulk (new Map(m) and
  // Map.groupBy insert through set() or the wrapped groupBy callback, both charged per key).
  guardKeyed(Map.prototype, ['get', 'has', 'set', 'delete', 'getOrInsert', 'getOrInsertComputed']);
  guardKeyed(Set.prototype, ['has', 'add', 'delete']);
  const origIs = Object.is;
  defineProperty(Object, 'is', {
    value: {
      is(a, b) {
        if (stopped) stopNow();
        if (typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length > KEY_FREE) charge(a.length);
        return origIs(a, b);
      },
    }.is,
    writable: true, enumerable: false, configurable: true,
  });
  // groupBy inserts every key the callback returns internally, past the guarded set(): the
  // callback is wrapped so a long string key is charged by its length, and a key that is an object
  // (Object.groupBy converts it with its own toString or valueOf, then hashes the result) reads the
  // clock. A loop of Map.groupBy over 1,000 elements with a 1 MB key ran 6 s past a 300 ms limit.
  for (const C of [Map, Set, Object]) {
    const d = getOwnPropertyDescriptor(C, 'groupBy');
    if (d === undefined || typeof d.value !== 'function') continue;
    const orig = d.value;
    const wrapper = {
      groupBy(items, callback) {
        if (stopped) stopNow();
        charge(sizeOf(items) + MIN_CHARGE);
        const cb = typeof callback !== 'function' ? callback : function (v, i) {
          const key = apply(callback, this, [v, i]);
          if (typeof key === 'string') {
            if (key.length > KEY_FREE) charge(key.length);
          } else if (key !== null && (typeof key === 'object' || typeof key === 'function')) {
            charge(UNTRUSTED);
          }
          return key;
        };
        return apply(orig, this, [items, cb]);
      },
    }.groupBy;
    defineProperty(wrapper, 'length', { value: orig.length });
    defineProperty(C, 'groupBy', { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  }
  // The set methods walk a whole Set natively (a loop of difference() on a 200,000-element Set
  // ran 0.2 s late): charged by both sizes and both key weights. Their argument may be any
  // set-like ({ size, has, keys }), whose keys() the method drains natively, hashing every key it
  // yields (a loop of union() with a set-like yielding a 1 MB key ran 2.8 s late, one union() with
  // a 4 MB key 11.9 s). So unless the argument is a plain Set whose size, has and keys are the
  // ones installed here (no own overrides, prototype unchanged), the wrapper reads size, has and
  // keys once itself, as GetSetRecord would, and hands the method a record whose keys() iterator
  // charges every long string key it passes on. The has() path needs nothing: has is script code,
  // and the keys it is asked about are this Set's own, charged by its weight.
  const installedHas = getOwnPropertyDescriptor(Set.prototype, 'has').value;
  const installedKeys = getOwnPropertyDescriptor(Set.prototype, 'keys').value;
  // The native method drains keys() through the iterator's next, looked up on the Set iterator
  // prototype: a script that replaces it would make a plain Set yield its own keys uncharged.
  const SetIteratorProto = getPrototypeOf(apply(installedKeys, new Set(), []));
  const setIteratorNext = getOwnPropertyDescriptor(SetIteratorProto, 'next').value;
  const isPlainSet = (x) => {
    if (isProxy(x) || getPrototypeOf(x) !== Set.prototype || slot(setSize, x) < 0) return false;
    if (apply(hasOwn, x, ['size']) || apply(hasOwn, x, ['has']) || apply(hasOwn, x, ['keys'])) return false;
    const proto = Set.prototype;
    const sizeD = getOwnPropertyDescriptor(proto, 'size');
    const hasD = getOwnPropertyDescriptor(proto, 'has');
    const keysD = getOwnPropertyDescriptor(proto, 'keys');
    const nextD = getOwnPropertyDescriptor(SetIteratorProto, 'next');
    return sizeD !== undefined && sizeD.get === setSize && hasD !== undefined && hasD.value === installedHas &&
      keysD !== undefined && keysD.value === installedKeys && nextD !== undefined && nextD.value === setIteratorNext;
  };
  for (const name of ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf',
    'isSupersetOf', 'isDisjointFrom']) {
    const d = getOwnPropertyDescriptor(Set.prototype, name);
    if (d === undefined || typeof d.value !== 'function') continue;
    const orig = d.value;
    const wrapper = {
      [name](other) {
        if (stopped) stopNow();
        const keys = weightOf(this) + weightOf(other);
        charge(sizeOf(this) + sizeOf(other) + keys + MIN_CHARGE);
        if (other === null || (typeof other !== 'object' && typeof other !== 'function') || isPlainSet(other)) {
          const result = apply(orig, this, [other]);
          addWeight(result, keys);
          return result;
        }
        // GetSetRecord's order: size read and checked before has and keys are read.
        const size = +other.size;
        if (size !== size) throw new TypeErr('The size of the set-like argument is not a number.');
        // ToIntegerOrInfinity(size) < 0 exactly when size <= -1 (-0.5 truncates to 0).
        if (size <= -1) throw new RangeErr('The size of the set-like argument is negative.');
        const has = other.has;
        if (typeof has !== 'function') throw new TypeErr('The set-like argument has no has() method.');
        const keysFn = other.keys;
        if (typeof keysFn !== 'function') throw new TypeErr('The set-like argument has no keys() method.');
        let yielded = 0;
        const record = {
          size,
          has(key) {
            return apply(has, other, [key]);
          },
          keys() {
            const it = apply(keysFn, other, []);
            if (it === null || (typeof it !== 'object' && typeof it !== 'function')) {
              throw new TypeErr('keys() of the set-like argument did not return an object.');
            }
            const next = it.next;
            return {
              next() {
                if (stopped) stopNow();
                const r = apply(next, it, []);
                if (r === null || (typeof r !== 'object' && typeof r !== 'function')) {
                  throw new TypeErr('An iterator result is not an object.');
                }
                const done = r.done;
                if (done) return { done: true, value: undefined };
                const value = r.value;
                if (typeof value === 'string' && value.length > KEY_FREE) {
                  charge(value.length);
                  yielded += value.length;
                }
                return { done: false, value };
              },
              // Methods that stop early (isDisjointFrom, isSupersetOf) close the iterator: the
              // script's own return() (a generator's finally) runs, as it would natively.
              return() {
                const ret = it.return;
                if (ret === undefined || ret === null) return { done: true, value: undefined };
                return apply(ret, it, []);
              },
            };
          },
        };
        const result = apply(orig, this, [record]);
        addWeight(result, keys + yielded);
        return result;
      },
    }[name];
    defineProperty(wrapper, 'length', { value: orig.length });
    defineProperty(Set.prototype, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  }

  // Constructors that also work as plain calls and parse their argument natively: Number (and
  // new Number) by the string's length, RegExp by the pattern's. Statics, subclassing,
  // instanceof and the constructor property keep working; the originals stay out of reach.
  const patternCost = (x) => {
    if (x === null || typeof x !== 'object') return sizeOf(x);
    const source = slot(regExpSource, x);
    return typeof source === 'string' ? source.length : UNTRUSTED;
  };
  const ownKeys = Reflect.ownKeys;
  const wrapCallable = (name, cost, plainCall) => {
    const orig = G[name];
    const wrapper = {
      [name]: function (...args) {
        if (stopped) stopNow();
        charge(cost(args) + MIN_CHARGE);
        if (new.target === undefined) return plainCall === undefined ? apply(orig, undefined, args) : plainCall(args);
        return construct(orig, args, new.target === wrapper ? orig : new.target);
      },
    }[name];
    for (const key of ownKeys(orig)) {
      if (key === 'prototype') continue;
      defineProperty(wrapper, key, getOwnPropertyDescriptor(orig, key));
    }
    defineProperty(wrapper, 'prototype', { value: orig.prototype, writable: false, enumerable: false, configurable: false });
    defineProperty(orig.prototype, 'constructor', { value: wrapper, writable: true, enumerable: false, configurable: true });
    defineProperty(G, name, { value: wrapper, writable: true, enumerable: false, configurable: true });
    return { orig, wrapper };
  };
  // Number(object) runs ToPrimitive, which is script code (valueOf, toString, Symbol.toPrimitive)
  // the interrupt handler sees, or a guarded builtin (Array and typed array toString): priced at
  // MIN_CHARGE only. The string that conversion returns is then parsed natively and is not
  // charged (a README residual).
  wrapCallable('Number', (args) => {
    const x = args[0];
    return x !== null && (typeof x === 'object' || typeof x === 'function') ? 0 : sizeOf(x);
  });
  // Number.parseFloat and Number.parseInt are the global functions (guarded above).
  defineProperty(Number, 'parseFloat', { value: G.parseFloat });
  defineProperty(Number, 'parseInt', { value: G.parseInt });
  const re = wrapCallable('RegExp', (args) => patternCost(args[0]) + sizeOf(args[1]), (args) => {
    // RegExp(r) returns r itself when r is a RegExp made by this constructor and no flags are
    // given; the original compares with itself, so the identity case is answered here. Edge
    // case: ECMAScript decides "is a RegExp" by Symbol.match, so a real RegExp whose
    // Symbol.match is set falsy would be copied there, and an object with a truthy Symbol.match
    // and constructor === RegExp would be returned as is; here only real RegExps (the source
    // slot) are returned unchanged and anything else goes to the original, which makes a copy.
    const p = args[0];
    if (args[1] === undefined && p !== null && typeof p === 'object' && typeof slot(regExpSource, p) === 'string' && p.constructor === re.wrapper) return p;
    return apply(re.orig, undefined, args);
  });
  // Annex B compile() recompiles in place.
  guard(RegExp.prototype, ['compile'], false, (self, args) => patternCost(args[0]) + sizeOf(args[1]));
  // new ArrayBuffer(n) zeroes n bytes, and transfer() and resize() copy or zero up to their
  // length: charged by the length asked for (a loop of new ArrayBuffer(16e6) ran 0.2 s late).
  // Anything but a number is converted natively (a string, or an object's valueOf): priced at
  // UNTRUSTED, which reads the clock, rather than run the conversion twice.
  const byteCount = (x) => (typeof x === 'number' ? (x > 0 ? x : 0) : x === undefined ? 0 : UNTRUSTED);
  wrapCallable('ArrayBuffer', (args) => byteCount(args[0]));
  guard(ArrayBuffer.prototype, ['transfer', 'transferToFixedLength', 'resize'], false,
    (self, args) => sizeOf(self) + byteCount(args[0]));

  // Typed array constructors copy an array or iterable natively: charged by the argument's size
  // (or the length asked for). The wrapper keeps new, subclassing and instanceof working.
  const setPrototypeOf = Object.setPrototypeOf;
  for (const name of ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array']) {
    const orig = G[name];
    if (typeof orig !== 'function') continue;
    const wrapper = {
      [name]: function (...args) {
        if (stopped) stopNow();
        if (new.target === undefined) throw new TypeErr('Constructor ' + name + ' requires new');
        const first = args[0];
        charge((typeof first === 'number' && first > 0 ? first : sizeOf(first)) + MIN_CHARGE);
        return construct(orig, args, new.target === wrapper ? orig : new.target);
      },
    }[name];
    setPrototypeOf(wrapper, getPrototypeOf(orig));
    defineProperty(wrapper, 'length', { value: orig.length });
    defineProperty(wrapper, 'prototype', { value: orig.prototype, writable: false, enumerable: false, configurable: false });
    defineProperty(wrapper, 'BYTES_PER_ELEMENT', { value: orig.BYTES_PER_ELEMENT });
    defineProperty(orig.prototype, 'constructor', { value: wrapper, writable: true, enumerable: false, configurable: true });
    defineProperty(G, name, { value: wrapper, writable: true, enumerable: false, configurable: true });
  }

  // ---- values across the boundary
  const handleIds = new WeakMapC();
  const handlesByIndex = new MapC();
  const HandleProto = freeze(ObjectCreate(null, {
    toString: { value: function toString() { return '[handle ' + this.kind + ']'; } },
  }));
  const handleFor = (index, kind) => {
    let h = apply(mapGet, handlesByIndex, [index]);
    if (h === undefined) {
      h = freeze(ObjectCreate(HandleProto, { kind: { value: StringC(kind), enumerable: true } }));
      apply(mapSet, handlesByIndex, [index, h]);
      apply(wmSet, handleIds, [h, index]);
    }
    return h;
  };
  const limit = (message) => {
    hostAbort('value-too-large', message);
    stopNow();
  };
  const NAN = { [MARK]: 'NaN' };
  const INF = { [MARK]: 'Infinity' };
  const NINF = { [MARK]: '-Infinity' };
  const NZERO = { [MARK]: '-0' };
  const encode = (value) => {
    let count = 0;
    const depthOf = new WeakMapC();
    const s = stringify(value, function replacer(key, v) {
      if (++count > maxElements + 1) limit('A value crossing the script boundary has more than ' + maxElements + ' elements.');
      if (key.length > maxString) limit('An object key crossing the script boundary is longer than ' + maxString + ' characters.');
      switch (typeof v) {
        case 'number':
          if (v !== v) return NAN;
          if (v === Infinity) return INF;
          if (v === -Infinity) return NINF;
          if (v === 0 && 1 / v < 0) return NZERO;
          return v;
        case 'string':
          if (v.length > maxString) limit('A string crossing the script boundary is longer than ' + maxString + ' characters.');
          return v;
        case 'boolean':
        case 'undefined':
          return v;
        case 'object': {
          if (v === null) return v;
          const h = apply(wmGet, handleIds, [v]);
          if (h !== undefined) return { [MARK]: h };
          const parentDepth = apply(wmGet, depthOf, [this]);
          const depth = (parentDepth === undefined ? 0 : parentDepth) + 1;
          if (depth > maxDepth) limit('A value crossing the script boundary is nested deeper than ' + maxDepth + ' levels.');
          if (isArray(v)) {
            if (v.length > maxElements) limit('A value crossing the script boundary has more than ' + maxElements + ' elements.');
          } else {
            const proto = getPrototypeOf(v);
            if (proto !== ObjectProto && proto !== null) {
              throw new TypeErr('Only numbers, strings, booleans, null, arrays, plain objects and handles can cross the script boundary' + (key === '' ? '' : ' (found at "' + key + '")') + '.');
            }
            if (apply(hasOwn, v, ['__proto__'])) throw new TypeErr('An object key named __proto__ cannot cross the script boundary.');
            if (apply(hasOwn, v, [MARK])) throw new TypeErr('This object key is reserved.');
          }
          apply(wmSet, depthOf, [v, depth]);
          return v;
        }
        default:
          throw new TypeErr('A ' + typeof v + ' cannot cross the script boundary' + (key === '' ? '' : ' (found at "' + key + '")') + '.');
      }
    });
    if (s !== undefined && s.length > maxPayload) limit('A value crossing the script boundary is larger than ' + maxPayload + ' characters as JSON.');
    return s;
  };
  const reviver = function (key, v) {
    if (v !== null && typeof v === 'object' && !isArray(v) && apply(hasOwn, v, [MARK])) {
      const m = v[MARK];
      if (typeof m === 'number') return handleFor(m, apply(hasOwn, v, ['kind']) ? v.kind : undefined);
      if (m === 'NaN') return NaN;
      if (m === 'Infinity') return Infinity;
      if (m === '-Infinity') return -Infinity;
      return -0;
    }
    return v;
  };
  const decode = (json) => (json === undefined ? undefined : parse(json, reviver));

  // ---- the ctx object handed to run()
  const call = (path, args) => {
    if (stopped) stopNow();
    return decode(hostCall(path, encode(args)));
  };
  const build = (shape, prefix) => {
    const out = ObjectCreate(null);
    for (const name of ObjectKeys(shape)) {
      const path = prefix === '' ? name : prefix + '.' + name;
      let member;
      if (shape[name] === 1) {
        member = { [name](...args) { return call(path, args); } }[name];
      } else {
        member = build(shape[name], path);
      }
      defineProperty(out, name, { value: member, enumerable: true });
    }
    return freeze(out);
  };
  const ctx = build(config.api, '');

  const exported = (ns, name) => {
    if (ns instanceof PromiseC) throw new TypeErr('Top-level await is not supported in scripts.');
    return apply(hasOwn, ns, [name]) ? ns[name] : undefined;
  };

  return freeze({
    read(ns) {
      const run = exported(ns, 'run');
      return encode({
        apiVersion: exported(ns, 'apiVersion'),
        params: exported(ns, 'params'),
        run: typeof run,
      });
    },
    run(ns, paramsJson) {
      const run = exported(ns, 'run');
      if (typeof run !== 'function') throw new TypeErr('The script must export a function run(ctx, params).');
      const result = apply(run, undefined, [ctx, decode(paramsJson)]);
      if (result instanceof PromiseC) throw new TypeErr('run() must return its result directly: async functions and promises are not supported.');
      return encode(result);
    },
  });
})`;
