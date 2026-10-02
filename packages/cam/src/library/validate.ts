// Strict checks of library data (T5.1d). A user library is outside input (an imported JSON file, or
// storage another build wrote), so it is checked field by field: unknown fields, wrong types,
// numbers out of range and broken kind rules are refused with the path of the first problem, and
// nothing is thrown. The built-in tools and machines pass the same checks in the tests.

import { err, ok, type CamResult } from '../types';
import { feedCategoryOf } from './feeds';
import { findSpindle } from './machines';
import {
  TOOL_LIBRARY_FORMAT,
  TOOL_LIBRARY_VERSION,
  type LibraryPreset,
  type LibraryTool,
  type MachineProfile,
  type Sourced,
  type ToolLibraryFile,
} from './types';

/** A CAM table id, as core's `CAM_TABLE_ID_PATTERN`. */
export const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Bounds on what a library file may hold, as core bounds a document's `cam.tools`. */
export const LIBRARY_LIMITS = {
  tools: 1000,
  presets: 100,
  name: 200,
  text: 2000,
  /** The largest tool length accepted, mm. */
  length: 1000,
  flutes: 32,
  toolNumber: 99_999,
  rpm: 100_000,
  /** The fastest feed accepted, mm/min. */
  feed: 100_000,
} as const;

/**
 * The smallest values accepted, so every allowed number is written as plain decimal text (never
 * an exponent) and none rounds to 0 when shown: lengths and angles 0.001 (in their unit), rpm and
 * feeds 1 (rpm, `unit` per minute), stepover 0.001.
 */
export const LIBRARY_MINIMUMS = { length: 0.001, rpm: 1, feed: 1, stepover: 0.001 } as const;
const MIN = LIBRARY_MINIMUMS;

const TOOL_KINDS = ['flat', 'ball', 'bull', 'vbit', 'drill', 'engraver'] as const;

type Obj = Record<string, unknown>;

class Invalid {
  constructor(
    readonly path: string,
    readonly message: string,
  ) {}
}

function fail(path: string, message: string): never {
  throw new Invalid(path, message);
}

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function object(v: unknown, path: string, required: string[], optional: string[] = []): Obj {
  if (!isPlainObject(v)) fail(path, 'expected an object');
  for (const key of Object.keys(v)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`${path}.${clip(key)}`, 'unknown field');
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(v, key)) fail(`${path}.${key}`, 'missing');
  }
  return v;
}

function text(v: unknown, path: string, max: number = LIBRARY_LIMITS.text): string {
  if (typeof v !== 'string') fail(path, 'expected text');
  if (v.length > max) fail(path, `longer than ${max} characters`);
  return v;
}

function name(v: unknown, path: string): string {
  const s = text(v, path, LIBRARY_LIMITS.name);
  if (s.trim() === '' || s.trim() !== s)
    fail(path, 'expected a name with no leading or trailing spaces');
  return s;
}

function id(v: unknown, path: string): string {
  const s = text(v, path, 64);
  if (!LIBRARY_ID_PATTERN.test(s)) {
    fail(path, 'expected an id of lower-case letters, digits, ".", "_" and "-"');
  }
  return s;
}

function url(v: unknown, path: string): string {
  const s = text(v, path);
  if (!/^https?:\/\/\S+$/.test(s)) fail(path, 'expected an http(s) URL');
  return s;
}

/** An unknown key as an error path shows it: at most 64 characters. */
function clip(key: string): string {
  return key.length > 64 ? `${key.slice(0, 64)}...` : key;
}

function number(v: unknown, path: string, min: number, max: number, minOpen = true): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  if (minOpen ? v <= min : v < min)
    fail(path, `must be ${minOpen ? 'greater than' : 'at least'} ${min}`);
  if (v > max) fail(path, `must be at most ${max}`);
  return v;
}

function integer(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(path, 'expected a whole number');
  if (v < min || v > max) fail(path, `must be from ${min} to ${max}`);
  return v;
}

/**
 * A preset's category: a feed category id, or one of core's material ids, stored as its feed
 * category (`oak` becomes `hardwood`). Anything else is refused.
 */
function category(v: unknown, path: string): string {
  const raw = id(v, path);
  const c = feedCategoryOf(raw);
  if (c === undefined) fail(path, `"${raw}" is not a feed category`);
  return c;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected true or false');
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    fail(path, `expected one of ${values.join(', ')}`);
  }
  return v as T;
}

function run<T>(f: () => T): CamResult<T> {
  try {
    return ok(f());
  } catch (e) {
    if (e instanceof Invalid) return err('invalid-input', `${e.path}: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Tools

function checkPreset(v: unknown, path: string): LibraryPreset {
  const o = object(
    v,
    path,
    ['category', 'unit', 'rpm', 'feed', 'plunge', 'stepdown', 'stepover', 'source', 'verified'],
    ['note'],
  );
  const unit = oneOf(o.unit, `${path}.unit`, ['mm', 'in'] as const);
  const scale = unit === 'in' ? 25.4 : 1;
  const verified = object(o.verified, `${path}.verified`, ['feeds', 'stepdown', 'stepover']);
  return {
    category: category(o.category, `${path}.category`),
    unit,
    rpm: number(o.rpm, `${path}.rpm`, MIN.rpm, LIBRARY_LIMITS.rpm, false),
    feed: number(o.feed, `${path}.feed`, MIN.feed, LIBRARY_LIMITS.feed / scale, false),
    plunge: number(o.plunge, `${path}.plunge`, MIN.feed, LIBRARY_LIMITS.feed / scale, false),
    stepdown: number(
      o.stepdown,
      `${path}.stepdown`,
      MIN.length,
      LIBRARY_LIMITS.length / scale,
      false,
    ),
    stepover: number(o.stepover, `${path}.stepover`, MIN.stepover, 1, false),
    source: text(o.source, `${path}.source`),
    verified: {
      feeds: bool(verified.feeds, `${path}.verified.feeds`),
      stepdown: bool(verified.stepdown, `${path}.verified.stepdown`),
      stepover: bool(verified.stepover, `${path}.verified.stepover`),
    },
    ...(o.note === undefined ? {} : { note: text(o.note, `${path}.note`) }),
  };
}

function checkTool(v: unknown, path: string): LibraryTool {
  const o = object(
    v,
    path,
    [
      'id',
      'name',
      'kind',
      'unit',
      'diameter',
      'fluteLength',
      'flutes',
      'source',
      'verified',
      'presets',
    ],
    ['vendor', 'shankDiameter', 'cornerRadius', 'angleDeg', 'tipDiameter', 'note'],
  );
  const kind = oneOf(o.kind, `${path}.kind`, TOOL_KINDS);
  const unit = oneOf(o.unit, `${path}.unit`, ['mm', 'in'] as const);
  const maxLength = LIBRARY_LIMITS.length / (unit === 'in' ? 25.4 : 1);
  const length = (key: string) => number(o[key], `${path}.${key}`, MIN.length, maxLength, false);
  const diameter = length('diameter');
  const has = (key: string) => o[key] !== undefined;

  if (kind === 'bull' && !has('cornerRadius'))
    fail(`${path}.cornerRadius`, 'a bull nose tool has a corner radius');
  if (kind !== 'bull' && has('cornerRadius'))
    fail(`${path}.cornerRadius`, `a ${kind} tool has no corner radius`);
  if (kind === 'vbit' && !has('angleDeg'))
    fail(`${path}.angleDeg`, 'a V-bit has an included angle');
  if (kind !== 'vbit' && kind !== 'drill' && has('angleDeg'))
    fail(`${path}.angleDeg`, `a ${kind} tool has no angle`);
  if (kind !== 'vbit' && has('tipDiameter'))
    fail(`${path}.tipDiameter`, `a ${kind} tool has no tip diameter`);

  let vendor: LibraryTool['vendor'];
  if (has('vendor')) {
    const vo = object(o.vendor, `${path}.vendor`, ['maker', 'number', 'url']);
    vendor = {
      maker: name(vo.maker, `${path}.vendor.maker`),
      number: integer(vo.number, `${path}.vendor.number`, 0, LIBRARY_LIMITS.toolNumber),
      url: url(vo.url, `${path}.vendor.url`),
    };
  }
  const cornerRadius = has('cornerRadius') ? length('cornerRadius') : undefined;
  if (cornerRadius !== undefined && cornerRadius > diameter / 2) {
    fail(`${path}.cornerRadius`, 'must be at most half the diameter');
  }
  const tipDiameter = has('tipDiameter')
    ? number(o.tipDiameter, `${path}.tipDiameter`, 0, diameter, false)
    : undefined;
  if (tipDiameter !== undefined && tipDiameter > 0 && tipDiameter < MIN.length) {
    fail(`${path}.tipDiameter`, `must be 0 (pointed) or at least ${MIN.length}`);
  }
  if (tipDiameter !== undefined && tipDiameter >= diameter) {
    fail(`${path}.tipDiameter`, 'must be less than the diameter');
  }

  if (!Array.isArray(o.presets)) fail(`${path}.presets`, 'expected a list');
  if (o.presets.length > LIBRARY_LIMITS.presets) {
    fail(`${path}.presets`, `more than ${LIBRARY_LIMITS.presets} presets`);
  }
  const presets = o.presets.map((p, i) => checkPreset(p, `${path}.presets[${i}]`));
  const seen = new Set<string>();
  presets.forEach((p, i) => {
    if (seen.has(p.category))
      fail(`${path}.presets[${i}].category`, `two presets for "${p.category}"`);
    seen.add(p.category);
  });

  return {
    id: id(o.id, `${path}.id`),
    name: name(o.name, `${path}.name`),
    kind,
    ...(vendor ? { vendor } : {}),
    unit,
    diameter,
    fluteLength: length('fluteLength'),
    flutes: integer(o.flutes, `${path}.flutes`, 1, LIBRARY_LIMITS.flutes),
    ...(has('shankDiameter') ? { shankDiameter: length('shankDiameter') } : {}),
    ...(cornerRadius === undefined ? {} : { cornerRadius }),
    ...(has('angleDeg')
      ? { angleDeg: number(o.angleDeg, `${path}.angleDeg`, MIN.length, 179.999, false) }
      : {}),
    ...(tipDiameter === undefined ? {} : { tipDiameter }),
    source: text(o.source, `${path}.source`),
    verified: bool(o.verified, `${path}.verified`),
    ...(has('note') ? { note: text(o.note, `${path}.note`) } : {}),
    presets,
  };
}

/** `value` as a library tool, or the first problem with its path. Returns a fresh copy. */
export function validateLibraryTool(value: unknown): CamResult<LibraryTool> {
  return run(() => checkTool(value, 'tool'));
}

/**
 * `value` (parsed JSON) as a tool library file: `{ format: 'manufakture-tool-library',
 * version: 1, tools }`, tool ids unique. Returns a fresh copy holding only known fields.
 */
export function validateToolLibraryFile(value: unknown): CamResult<ToolLibraryFile> {
  return run(() => {
    const o = object(value, 'library', ['format', 'version', 'tools']);
    if (o.format !== TOOL_LIBRARY_FORMAT)
      fail('library.format', `expected "${TOOL_LIBRARY_FORMAT}"`);
    if (o.version !== TOOL_LIBRARY_VERSION) {
      fail(
        'library.version',
        `expected ${TOOL_LIBRARY_VERSION}; this file is from another version`,
      );
    }
    if (!Array.isArray(o.tools)) fail('library.tools', 'expected a list');
    if (o.tools.length > LIBRARY_LIMITS.tools)
      fail('library.tools', `more than ${LIBRARY_LIMITS.tools} tools`);
    const tools = o.tools.map((t, i) => checkTool(t, `library.tools[${i}]`));
    const ids = new Set<string>();
    tools.forEach((t, i) => {
      if (ids.has(t.id)) fail(`library.tools[${i}].id`, `two tools with id "${t.id}"`);
      ids.add(t.id);
    });
    return { format: TOOL_LIBRARY_FORMAT, version: TOOL_LIBRARY_VERSION, tools };
  });
}

/** Parses and checks a tool library's JSON text. */
export function parseToolLibrary(json: string): CamResult<ToolLibraryFile> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return err('invalid-input', 'library: not JSON');
  }
  return validateToolLibraryFile(value);
}

/** A tool library file's JSON text, for export. */
export function serializeToolLibrary(tools: readonly LibraryTool[]): string {
  const file: ToolLibraryFile = {
    format: TOOL_LIBRARY_FORMAT,
    version: TOOL_LIBRARY_VERSION,
    tools,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Machines

function sourced<T>(s: Sourced<T>, path: string, check: (v: T, path: string) => void): void {
  object(s, path, ['value', 'source', 'verified'], ['note']);
  text(s.source, `${path}.source`);
  if (s.source.trim() === '') fail(`${path}.source`, 'a sourced value names its source');
  bool(s.verified, `${path}.verified`);
  if (s.note !== undefined) text(s.note, `${path}.note`);
  check(s.value, `${path}.value`);
}

/** Checks a machine profile: ids, sourced numbers in range, a known spindle with a sane dial, posts. */
export function validateMachine(m: MachineProfile): CamResult<MachineProfile> {
  return run(() => {
    const p = `machine ${m.id}`;
    id(m.id, `${p}.id`);
    name(m.name, `${p}.name`);
    name(m.maker, `${p}.maker`);
    url(m.url, `${p}.url`);
    const positiveMm = (max: number) => (v: number, path: string) => void number(v, path, 0, max);
    sourced(m.travel.x, `${p}.travel.x`, positiveMm(LIBRARY_LIMITS.length * 10));
    sourced(m.travel.y, `${p}.travel.y`, positiveMm(LIBRARY_LIMITS.length * 10));
    sourced(m.travel.z, `${p}.travel.z`, positiveMm(LIBRARY_LIMITS.length));
    sourced(m.maxFeed, `${p}.maxFeed`, positiveMm(LIBRARY_LIMITS.feed));
    sourced(m.maxRapid, `${p}.maxRapid`, positiveMm(LIBRARY_LIMITS.feed));
    sourced(
      m.firmware,
      `${p}.firmware`,
      (v, path) => void oneOf(v, path, ['grbl-1.1', 'grblhal'] as const),
    );
    sourced(m.sender, `${p}.sender`, (v, path) => void id(v, path));
    sourced(m.toolLengthSensor, `${p}.toolLengthSensor`, (v, path) => void bool(v, path));
    sourced(m.spindle, `${p}.spindle`, (v, path) => {
      const spindle = findSpindle(v);
      if (!spindle) fail(path, `unknown spindle "${v}"`);
      sourced(spindle.rpmRange, `${path}.rpmRange`, ([lo, hi], rp) => {
        number(lo, `${rp}[0]`, 0, LIBRARY_LIMITS.rpm);
        number(hi, `${rp}[1]`, lo, LIBRARY_LIMITS.rpm);
      });
      if (spindle.kind === 'router' && !spindle.dial) fail(path, 'a router has a dial table');
      if (spindle.dial) {
        sourced(spindle.dial, `${path}.dial`, (dial, dp) => {
          if (dial.length === 0) fail(dp, 'an empty dial');
          dial.forEach((d, i) => {
            if (d.setting.trim() === '') fail(`${dp}[${i}].setting`, 'empty');
            number(d.rpm, `${dp}[${i}].rpm`, i === 0 ? 0 : dial[i - 1]!.rpm, LIBRARY_LIMITS.rpm);
          });
        });
      }
    });
    if (m.spindleOptions[0] !== m.spindle.value) {
      fail(`${p}.spindleOptions`, 'the default spindle comes first');
    }
    for (const [i, s] of m.spindleOptions.entries()) {
      if (!findSpindle(s)) fail(`${p}.spindleOptions[${i}]`, `unknown spindle "${s}"`);
    }
    if (m.posts.length === 0) fail(`${p}.posts`, 'a machine has at least one post');
    m.posts.forEach((post, i) => id(post, `${p}.posts[${i}]`));
    return m;
  });
}
