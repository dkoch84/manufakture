// Structural checks for plain data that arrives by structured clone (ops and
// feature inputs): each returns why a value is malformed, or null.

export type Check = (value: unknown, path: string) => string | null;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const num: Check = (v, p) => (typeof v === 'number' ? null : `${p} must be a number`);
export const bool: Check = (v, p) => (typeof v === 'boolean' ? null : `${p} must be a boolean`);
export const str: Check = (v, p) => (typeof v === 'string' ? null : `${p} must be a string`);
export const vec2: Check = (v, p) =>
  Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'number')
    ? null
    : `${p} must be [number, number]`;
export const vec3: Check = (v, p) =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number')
    ? null
    : `${p} must be [number, number, number]`;
export const shapeRef: Check = (v, p) =>
  (typeof v === 'number' && Number.isInteger(v)) ||
  (isObject(v) &&
    typeof v.result === 'number' &&
    Number.isInteger(v.result) &&
    (v.body === undefined || typeof v.body === 'string'))
    ? null
    : `${p} must be a shape id or { result: <op index>, body? }`;
export const arrayOf =
  (item: Check, nonEmpty = false): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return `${p} must be an array`;
    if (nonEmpty && v.length === 0) return `${p} must not be empty`;
    for (let i = 0; i < v.length; i++) {
      const e = item(v[i], `${p}[${i}]`);
      if (e) return e;
    }
    return null;
  };
export const oneOf =
  (...values: string[]): Check =>
  (v, p) =>
    typeof v === 'string' && values.includes(v) ? null : `${p} must be one of ${values.join(', ')}`;
export const either =
  (a: Check, b: Check, what: string): Check =>
  (v, p) =>
    a(v, p) === null || b(v, p) === null ? null : `${p} must be ${what}`;
export const shape =
  (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v, p) => {
    if (!isObject(v)) return `${p} must be an object`;
    for (const [k, check] of Object.entries(fields)) {
      const e = check(v[k], `${p}.${k}`);
      if (e) return e;
    }
    for (const [k, check] of Object.entries(optional)) {
      if (v[k] === undefined) continue;
      const e = check(v[k], `${p}.${k}`);
      if (e) return e;
    }
    return null;
  };

export const entity: Check = (v, p) => {
  if (!isObject(v)) return `${p} must be an object`;
  switch (v.kind) {
    case 'line':
      return shape({ start: vec2, end: vec2 }, { id: str })(v, p);
    case 'arc':
      return shape({ center: vec2, start: vec2, end: vec2 }, { clockwise: bool, id: str })(v, p);
    case 'circle':
      return shape({ center: vec2, radius: num }, { id: str })(v, p);
    case 'bezier':
      return shape({ points: arrayOf(vec2, true) }, { id: str })(v, p);
    default:
      return `${p}.kind must be line, arc, circle or bezier`;
  }
};

export const frame = shape({ origin: vec3, xDir: vec3, normal: vec3 });
export const loop = shape({ entities: arrayOf(entity, true) });
