// The host side of the binding: payloads from the script are untrusted input, validated here
// before any host function sees them; values to the script are checked against the same limits.
// The wire format is JSON with marker objects (`{ "\u0000mfk": ... }`) for handles, NaN, the
// infinities and -0 (prelude.ts writes and reads the other side).

import { ScriptHandle, type ScriptValue } from './host';
import { MARK } from './prelude';

export interface ValueLimits {
  maxStringLength: number;
  maxElements: number;
  maxDepth: number;
  maxPayloadLength: number;
}

/** A payload or value that breaks a rule; `tooLarge` separates size limits from bad shapes. */
export class CodecError extends Error {
  override readonly name = 'CodecError';
  readonly tooLarge: boolean;

  constructor(message: string, tooLarge: boolean) {
    super(message);
    this.tooLarge = tooLarge;
  }
}

const SPECIAL_NUMBERS: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
  '-0': -0,
};

/** The handles of one run: index in payloads to host handle, and back. */
export class HandleTable {
  private readonly list: ScriptHandle[] = [];
  private readonly index = new Map<ScriptHandle, number>();

  get size(): number {
    return this.list.length;
  }

  get(i: number): ScriptHandle | undefined {
    return this.list[i];
  }

  indexOf(handle: ScriptHandle): number {
    let i = this.index.get(handle);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(handle);
      this.index.set(handle, i);
    }
    return i;
  }
}

/**
 * Deepest nesting in a JSON text, counting `[` and `{` outside strings. Runs before `JSON.parse`
 * so a hostile payload never makes the host recurse deeply.
 */
export function jsonDepth(json: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 93 || c === 125) depth--;
  }
  return max;
}

/**
 * Decodes a payload from the script. `extraDepth` allows for a wrapper the glue adds (the
 * argument array of a call).
 */
export function decodePayload(
  json: string,
  handles: HandleTable,
  limits: ValueLimits,
  extraDepth = 0,
): ScriptValue {
  if (json.length > limits.maxPayloadLength) {
    throw new CodecError(
      `A value crossing the script boundary is larger than ${limits.maxPayloadLength} characters as JSON.`,
      true,
    );
  }
  if (jsonDepth(json) > limits.maxDepth + extraDepth) {
    throw new CodecError(
      `A value crossing the script boundary is nested deeper than ${limits.maxDepth} levels.`,
      true,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodecError('The script sent a value that is not valid JSON.', false);
  }
  let count = 0;
  const visit = (v: unknown): ScriptValue => {
    if (++count > limits.maxElements + 1 + extraDepth) {
      throw new CodecError(
        `A value crossing the script boundary has more than ${limits.maxElements} elements.`,
        true,
      );
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') {
      if (v.length > limits.maxStringLength) {
        throw new CodecError(
          `A string crossing the script boundary is longer than ${limits.maxStringLength} characters.`,
          true,
        );
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    const object = v as Record<string, unknown>;
    const keys = Object.keys(object);
    if (Object.prototype.hasOwnProperty.call(object, MARK)) {
      if (keys.length !== 1) throw new CodecError('Malformed marker in a script value.', false);
      const m = object[MARK];
      if (typeof m === 'number') {
        const handle = Number.isInteger(m) ? handles.get(m) : undefined;
        if (handle === undefined) throw new CodecError('Unknown handle in a script value.', false);
        return handle;
      }
      if (typeof m === 'string' && Object.prototype.hasOwnProperty.call(SPECIAL_NUMBERS, m)) {
        return SPECIAL_NUMBERS[m];
      }
      throw new CodecError('Malformed marker in a script value.', false);
    }
    const out: { [key: string]: ScriptValue } = {};
    for (const key of keys) {
      if (key === '__proto__') {
        throw new CodecError(
          'An object key named __proto__ cannot cross the script boundary.',
          false,
        );
      }
      if (key.length > limits.maxStringLength) {
        throw new CodecError(
          `An object key crossing the script boundary is longer than ${limits.maxStringLength} characters.`,
          true,
        );
      }
      out[key] = visit(object[key]);
    }
    return out;
  };
  return visit(parsed);
}

/** Encodes a host value for the script, or undefined for "no value". */
export function encodeValue(
  value: unknown,
  handles: HandleTable,
  limits: ValueLimits,
): string | undefined {
  if (value === undefined) return undefined;
  let count = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++count > limits.maxElements + 1) {
      throw new CodecError(
        `A value crossing the script boundary has more than ${limits.maxElements} elements.`,
        true,
      );
    }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return { [MARK]: 'NaN' };
      if (v === Infinity) return { [MARK]: 'Infinity' };
      if (v === -Infinity) return { [MARK]: '-Infinity' };
      if (Object.is(v, -0)) return { [MARK]: '-0' };
      return v;
    }
    if (typeof v === 'string') {
      if (v.length > limits.maxStringLength) {
        throw new CodecError(
          `A string crossing the script boundary is longer than ${limits.maxStringLength} characters.`,
          true,
        );
      }
      return v;
    }
    if (v instanceof ScriptHandle) return { [MARK]: handles.indexOf(v), kind: v.kind };
    if (typeof v !== 'object')
      throw new CodecError(`A ${typeof v} cannot cross to a script.`, false);
    if (depth >= limits.maxDepth) {
      throw new CodecError(
        `A value crossing the script boundary is nested deeper than ${limits.maxDepth} levels.`,
        true,
      );
    }
    if (Array.isArray(v))
      return v.map((item) => (item === undefined ? null : visit(item, depth + 1)));
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new CodecError('Only plain objects and arrays can cross to a script.', false);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v)) {
      if (key === '__proto__' || key === MARK) {
        throw new CodecError(
          `The object key ${JSON.stringify(key)} cannot cross to a script.`,
          false,
        );
      }
      if (item !== undefined) out[key] = visit(item, depth + 1);
    }
    return out;
  };
  const json = JSON.stringify(visit(value, 0));
  if (json.length > limits.maxPayloadLength) {
    throw new CodecError(
      `A value crossing the script boundary is larger than ${limits.maxPayloadLength} characters as JSON.`,
      true,
    );
  }
  return json;
}
