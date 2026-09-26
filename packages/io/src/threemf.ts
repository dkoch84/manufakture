// 3MF (3D Manufacturing Format, core specification 1.3): the package is a
// zip with [Content_Types].xml, _rels/.rels and the model part
// 3D/3dmodel.model. We write the core subset slicers need: unit millimetre,
// one mesh object per body with its name, and a build item per object. The
// reader parses that same subset (mesh objects and build items) back, for
// structural validation and tests; it does not implement components,
// materials or extensions.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { checkManifold, type ManifoldReport } from './manifold';
import type { NamedMesh, TriMesh } from './mesh';

export const CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MODEL_PATH = '3D/3dmodel.model';
export const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
export const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';

export type ModelUnit = 'micron' | 'millimeter' | 'centimeter' | 'inch' | 'foot' | 'meter';

export interface ThreeMfWriteOptions {
  /** `Title` metadata; omitted when absent. */
  title?: string;
  /** `Application` metadata. */
  application?: string;
  /** Zip entry dates; default now. Pass a fixed date for reproducible files. */
  modified?: Date;
}

/**
 * A 3MF package: unit millimetre, one object per mesh (`type="model"`, with
 * its name) and one build item per object. Meshes must be closed and wound
 * counter-clockwise from outside (see `checkManifold`); the writer does not
 * repair them.
 */
export function write3mf(
  objects: readonly NamedMesh[],
  options: ThreeMfWriteOptions = {},
): Uint8Array {
  if (objects.length === 0) throw new RangeError('a 3MF file needs at least one object');
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}">\n`);
  parts.push(
    ` <metadata name="Application">${xml(options.application ?? 'manufakture')}</metadata>\n`,
  );
  if (options.title !== undefined)
    parts.push(` <metadata name="Title">${xml(options.title)}</metadata>\n`);
  parts.push(' <resources>\n');
  objects.forEach((o, i) => {
    parts.push(
      `  <object id="${i + 1}" name="${xml(o.name)}" type="model">\n   <mesh>\n    <vertices>\n`,
    );
    const p = o.mesh.positions;
    for (let v = 0; v < p.length; v += 3) {
      parts.push(`     <vertex x="${num(p[v]!)}" y="${num(p[v + 1]!)}" z="${num(p[v + 2]!)}"/>\n`);
    }
    parts.push('    </vertices>\n    <triangles>\n');
    const t = o.mesh.indices;
    for (let k = 0; k + 2 < t.length; k += 3) {
      parts.push(`     <triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>\n`);
    }
    parts.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  parts.push(' </resources>\n <build>\n');
  objects.forEach((_, i) => parts.push(`  <item objectid="${i + 1}"/>\n`));
  parts.push(' </build>\n</model>\n');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ` <Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>\n` +
    ` <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>\n` +
    '</Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ` <Relationship Target="/${MODEL_PATH}" Id="rel0" Type="${MODEL_RELATIONSHIP}"/>\n` +
    '</Relationships>\n';
  const mtime = options.modified ?? new Date();
  return zipSync(
    {
      '[Content_Types].xml': [strToU8(contentTypes), { mtime }],
      '_rels/.rels': [strToU8(rels), { mtime }],
      [MODEL_PATH]: [strToU8(parts.join('')), { mtime }],
    },
    { level: 6 },
  );
}

/** A coordinate in mm to a nanometre, without exponents or trailing zeros. */
function num(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Text as XML attribute or element content. Markup characters are escaped; tab, newline and
 * carriage return become character references, since a parser normalises raw ones in an
 * attribute to spaces; every character XML 1.0 does not allow at all is dropped: the other
 * controls, U+FFFE, U+FFFF and unpaired surrogates (a JavaScript string may hold them).
 */
function xml(text: string): string {
  let out = '';
  // for...of walks code points: a valid pair arrives whole, an unpaired surrogate alone.
  for (const c of text) {
    const code = c.codePointAt(0)!;
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === '\t') out += '&#x9;';
    else if (c === '\n') out += '&#xA;';
    else if (c === '\r') out += '&#xD;';
    else if (code < 0x20 || code === 0xfffe || code === 0xffff) continue;
    else if (code >= 0xd800 && code <= 0xdfff) continue;
    else out += c;
  }
  return out;
}

function unxml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Reading -----------------------------------------------------------------------------

export interface ThreeMfObject {
  id: number;
  name: string;
  type: string;
  mesh: TriMesh;
}

export interface ThreeMfItem {
  objectId: number;
  /** The item's 3x4 transform as written (12 numbers), or null for identity. */
  transform: number[] | null;
}

export interface ParsedThreeMf {
  unit: ModelUnit;
  /** Every package entry, for checks. */
  entries: string[];
  /** The model part named by the root relationship. */
  modelPath: string;
  contentTypes: { extension: string; contentType: string }[];
  metadata: Record<string, string>;
  objects: ThreeMfObject[];
  items: ThreeMfItem[];
}

export class ThreeMfParseError extends Error {
  override readonly name = 'ThreeMfParseError';
}

/** Parse the core subset this package writes: mesh objects and build items. */
export function parse3mf(bytes: Uint8Array): ParsedThreeMf {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new ThreeMfParseError(`not a zip package: ${e instanceof Error ? e.message : String(e)}`);
  }
  const entries = Object.keys(files).sort();
  const text = (path: string): string => {
    const f = files[path] ?? files[path.replace(/^\//, '')];
    if (!f) throw new ThreeMfParseError(`the package has no ${path}`);
    return strFromU8(f);
  };
  const contentTypes = [...text('[Content_Types].xml').matchAll(tag('Default'))].map((m) => {
    const a = attributes(m[1]!);
    return { extension: a.Extension ?? '', contentType: a.ContentType ?? '' };
  });
  const rels = [...text('_rels/.rels').matchAll(tag('Relationship'))].map((m) => attributes(m[1]!));
  const root = rels.find((r) => r.Type === MODEL_RELATIONSHIP);
  if (!root?.Target) throw new ThreeMfParseError('no relationship names a 3D model part');
  const modelPath = root.Target.replace(/^\//, '');
  const model = text(modelPath);

  const modelTag = tag('model').exec(model);
  if (!modelTag) throw new ThreeMfParseError('the model part has no <model> element');
  const unit = (attributes(modelTag[1]!).unit ?? 'millimeter') as ModelUnit;
  const metadata: Record<string, string> = {};
  for (const m of model.matchAll(/<(?:\w+:)?metadata\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?metadata>/g)) {
    const name = attributes(m[1]!).name;
    if (name) metadata[name] = unxml(m[2]!.trim());
  }

  const objects: ThreeMfObject[] = [];
  for (const m of model.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
    const a = attributes(m[1]!);
    const body = m[2]!;
    if (/<(?:\w+:)?components\b/.test(body)) {
      throw new ThreeMfParseError(`object ${a.id}: components are not supported`);
    }
    const positions: number[] = [];
    for (const v of body.matchAll(tag('vertex'))) {
      const va = attributes(v[1]!);
      positions.push(Number(va.x), Number(va.y), Number(va.z));
    }
    const indices: number[] = [];
    for (const t of body.matchAll(tag('triangle'))) {
      const ta = attributes(t[1]!);
      indices.push(Number(ta.v1), Number(ta.v2), Number(ta.v3));
    }
    if (positions.some((x) => !Number.isFinite(x)) || indices.some((x) => !Number.isInteger(x))) {
      throw new ThreeMfParseError(`object ${a.id}: a vertex or triangle is malformed`);
    }
    objects.push({
      id: Number(a.id),
      name: unxml(a.name ?? ''),
      type: a.type ?? 'model',
      mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) },
    });
  }
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(model)?.[1] ?? '';
  const items = [...build.matchAll(tag('item'))].map((m) => {
    const a = attributes(m[1]!);
    return {
      objectId: Number(a.objectid),
      transform: a.transform ? a.transform.trim().split(/\s+/).map(Number) : null,
    };
  });
  return { unit, entries, modelPath, contentTypes, metadata, objects, items };
}

/** Opening tags (self-closing or not) of an element, any namespace prefix; group 1 is its attributes. */
function tag(name: string): RegExp {
  return new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)/?>`, 'g');
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return out;
}

// Validation --------------------------------------------------------------------------

export interface ThreeMfReport {
  ok: boolean;
  problems: string[];
  parsed: ParsedThreeMf | null;
  /** Per object, its manifold check. */
  objects: { id: number; name: string; manifold: ManifoldReport }[];
}

/**
 * Structural checks a slicer relies on: the package parts and content types,
 * unit millimetre, every object a closed, consistently wound, outward mesh
 * with triangle indices in range, and every build item naming an object.
 */
export function validate3mf(bytes: Uint8Array): ThreeMfReport {
  let parsed: ParsedThreeMf;
  try {
    parsed = parse3mf(bytes);
  } catch (e) {
    return {
      ok: false,
      problems: [e instanceof Error ? e.message : String(e)],
      parsed: null,
      objects: [],
    };
  }
  const problems: string[] = [];
  const types = new Map(parsed.contentTypes.map((c) => [c.extension.toLowerCase(), c.contentType]));
  if (types.get('rels') !== RELS_CONTENT_TYPE) problems.push('no content type for .rels');
  const modelExt = parsed.modelPath.split('.').pop()!.toLowerCase();
  if (types.get(modelExt) !== MODEL_CONTENT_TYPE) problems.push('no 3D model content type');
  if (parsed.unit !== 'millimeter') problems.push(`the unit is ${parsed.unit}, not millimeter`);
  if (parsed.objects.length === 0) problems.push('the model has no objects');
  const ids = new Set<number>();
  const objects = parsed.objects.map((o) => {
    if (ids.has(o.id)) problems.push(`object id ${o.id} is used twice`);
    ids.add(o.id);
    const vertices = o.mesh.positions.length / 3;
    if (o.mesh.indices.some((i) => i >= vertices)) {
      problems.push(`object ${o.id}: a triangle names a vertex that does not exist`);
    }
    const manifold = checkManifold(o.mesh);
    for (const p of manifold.problems) problems.push(`object ${o.id} (${o.name}): ${p}`);
    return { id: o.id, name: o.name, manifold };
  });
  if (parsed.items.length === 0) problems.push('the build has no items');
  for (const item of parsed.items) {
    if (!ids.has(item.objectId))
      problems.push(`a build item names object ${item.objectId}, which does not exist`);
  }
  return { ok: problems.length === 0, problems, parsed, objects };
}
