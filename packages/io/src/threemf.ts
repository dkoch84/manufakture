// 3MF (3D Manufacturing Format, core specification 1.3): the package is a
// zip with [Content_Types].xml, _rels/.rels and the model part
// 3D/3dmodel.model. We write the subset slicers need: unit millimetre, one
// mesh object per body with its name and (materials extension) its colour as
// a colour group of its own, objects made of other objects (components) and
// build items, with rigid transforms where they place something. A file with
// a components object also gets a minimal Metadata/model_settings.config
// (names and filament slots of the object and its parts), without which
// OrcaSlicer and Bambu Studio lose both (docs/research/slicer-handoff.md,
// section 6). The reader parses that subset back, for structural validation
// and tests; it does not implement the other materials or any extension.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { checkManifold, type ManifoldReport } from './manifold';
import type { NamedMesh, TriMesh } from './mesh';
import {
  IDENTITY_MATRIX,
  composeMatrices,
  isIdentity,
  matrixDeterminant,
  transformMesh,
  type Matrix3x4,
} from './placement';

export const CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIALS_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
export const MODEL_PATH = '3D/3dmodel.model';
/** OrcaSlicer's and Bambu Studio's per-object settings part; we write names and slots only. */
export const MODEL_SETTINGS_PATH = 'Metadata/model_settings.config';
export const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
export const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const CONFIG_CONTENT_TYPE = 'text/xml';

export type ModelUnit = 'micron' | 'millimeter' | 'centimeter' | 'inch' | 'foot' | 'meter';

export interface ThreeMfWriteOptions {
  /** `Title` metadata; omitted when absent. */
  title?: string;
  /**
   * `Application` metadata, default `manufakture`. A value naming Bambu Studio or OrcaSlicer is
   * refused: those slicers take such a file for one of their own projects.
   */
  application?: string;
  /** Zip entry dates; default now. Pass a fixed date for reproducible files. */
  modified?: Date;
  /**
   * The build: which objects (by index in `objects`) are made, and where. Default: one item per
   * object, unmoved.
   */
  items?: readonly ThreeMfBuildItem[];
}

/** A mesh object: a body, with its colour (`#rrggbb`, any case) if it has one. */
export interface ThreeMfMeshInput extends NamedMesh {
  color?: string;
}

/** An object made of other objects, each placed: a part of several bodies kept as one object. */
export interface ThreeMfComponentsInput {
  name: string;
  /** `object` is an index in the `objects` list, before this one (3MF defines before use). */
  components: readonly { object: number; transform?: Matrix3x4 }[];
}

export type ThreeMfObjectInput = ThreeMfMeshInput | ThreeMfComponentsInput;

/** One thing the build makes: an object (by index in `objects`), placed by `transform`. */
export interface ThreeMfBuildItem {
  object: number;
  transform?: Matrix3x4;
}

/** Entries of a rotation part this far from orthonormal are not rigid (written to 1e-9). */
const RIGID_TOLERANCE = 1e-6;

/**
 * What is wrong with a transform for us: not 12 finite numbers, a mirror or a collapse (a
 * determinant that is not positive), or a scale or shear (not rigid). Null when it is a rigid
 * motion.
 */
function transformProblem(m: readonly number[]): 'malformed' | 'mirrors' | 'not rigid' | null {
  if (m.length !== 12 || !m.every(Number.isFinite)) return 'malformed';
  if (!(matrixDeterminant(m) > 0)) return 'mirrors';
  for (let r = 0; r < 3; r++) {
    for (let c = r; c < 3; c++) {
      const dot =
        m[r * 3]! * m[c * 3]! + m[r * 3 + 1]! * m[c * 3 + 1]! + m[r * 3 + 2]! * m[c * 3 + 2]!;
      if (Math.abs(dot - (r === c ? 1 : 0)) > RIGID_TOLERANCE) return 'not rigid';
    }
  }
  return null;
}

/** `#RRGGBB` from `#rrggbb` in any case; throws on anything else. */
function colorOf(color: string, what: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new RangeError(`${what}: ${color} is not #rrggbb`);
  return color.toUpperCase();
}

/**
 * A 3MF package: unit millimetre, one object per input (`type="model"`, with its name): a mesh,
 * or components placing earlier objects; then the build, one item per object unless
 * `options.items` says otherwise. Meshes must be closed and wound counter-clockwise from outside
 * (see `checkManifold`); the writer does not repair them. Transforms must be rigid (a rotation and
 * a move: no mirror, scale or shear).
 *
 * Colours: the materials namespace is declared with the prefix `m`, each distinct colour (in
 * first-use order) gets a colour group of its own holding that one colour, and each coloured mesh
 * object names its group with `pid` and `pindex="0"`. Groups come first in the resources, so
 * they take ids 1 to n and objects follow. No `requiredextensions`: a reader without the
 * materials extension still reads the geometry. OrcaSlicer and Bambu Studio give each group a
 * filament slot, in order.
 *
 * Components: when any object is made of components, `Metadata/model_settings.config` is
 * written too, giving every object the build makes its `name` and filament slot (`extruder`, the
 * position of its colour among the groups), and every part of a components object (each
 * distinct object it places, by id) its `name` and slot. Nothing else goes in it: no plates,
 * matrices or project settings. Without it OrcaSlicer and Bambu Studio name the parts after the
 * object and print them all in one slot.
 */
export function write3mf(
  objects: readonly ThreeMfObjectInput[],
  options: ThreeMfWriteOptions = {},
): Uint8Array {
  if (objects.length === 0) throw new RangeError('a 3MF file needs at least one object');
  const items: readonly ThreeMfBuildItem[] =
    options.items ?? objects.map((_, object) => ({ object }));
  if (items.length === 0) throw new RangeError('a 3MF build needs at least one item');
  const application = options.application ?? 'manufakture';
  if (/bambu|orca/i.test(application)) {
    throw new RangeError('the Application metadata must not claim Bambu Studio or OrcaSlicer');
  }
  const checkTransform = (m: Matrix3x4 | undefined, what: string) => {
    if (m === undefined) return;
    const problem = transformProblem(m);
    if (problem === 'malformed') throw new RangeError(`${what}: a transform is 12 finite numbers`);
    if (problem === 'mirrors') throw new RangeError(`${what}: the transform mirrors`);
    if (problem === 'not rigid') throw new RangeError(`${what}: the transform is not rigid`);
  };

  // Colour groups, one per distinct colour in first-use order; ids 1..n, objects after them.
  const colors: string[] = [];
  const groupOf = objects.map((o, i) => {
    if ('components' in o || o.color === undefined) return null;
    const c = colorOf(o.color, `object ${i}`);
    if (!colors.includes(c)) colors.push(c);
    return colors.indexOf(c);
  });
  const idOf = (index: number) => colors.length + index + 1;

  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const materials = colors.length > 0 ? ` xmlns:m="${MATERIALS_NAMESPACE}"` : '';
  parts.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}"${materials}>\n`);
  parts.push(` <metadata name="Application">${xml(application)}</metadata>\n`);
  if (options.title !== undefined)
    parts.push(` <metadata name="Title">${xml(options.title)}</metadata>\n`);
  parts.push(' <resources>\n');
  colors.forEach((c, g) => {
    parts.push(`  <m:colorgroup id="${g + 1}">\n   <m:color color="${c}"/>\n  </m:colorgroup>\n`);
  });
  objects.forEach((o, i) => {
    const group = groupOf[i];
    const props = group === null || group === undefined ? '' : ` pid="${group + 1}" pindex="0"`;
    parts.push(`  <object id="${idOf(i)}" name="${xml(o.name)}" type="model"${props}>\n`);
    if ('components' in o) {
      if (o.components.length === 0) throw new RangeError(`object ${i} has no components`);
      parts.push('   <components>\n');
      for (const c of o.components) {
        if (!Number.isInteger(c.object) || c.object < 0 || c.object >= i) {
          throw new RangeError(`object ${i}: a component must be an object before it`);
        }
        checkTransform(c.transform, `object ${i}`);
        parts.push(
          `    <component objectid="${idOf(c.object)}"${transformAttribute(c.transform)}/>\n`,
        );
      }
      parts.push('   </components>\n  </object>\n');
      return;
    }
    parts.push('   <mesh>\n    <vertices>\n');
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
  for (const item of items) {
    if (!Number.isInteger(item.object) || item.object < 0 || item.object >= objects.length) {
      throw new RangeError(`a build item names object ${item.object}, which is not in the list`);
    }
    checkTransform(item.transform, `the item of object ${item.object}`);
    parts.push(`  <item objectid="${idOf(item.object)}"${transformAttribute(item.transform)}/>\n`);
  }
  parts.push(' </build>\n</model>\n');

  const settings = objects.some((o) => 'components' in o)
    ? modelSettings(objects, items, groupOf, idOf)
    : null;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ` <Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>\n` +
    ` <Default Extension="model" ContentType="${MODEL_CONTENT_TYPE}"/>\n` +
    (settings === null
      ? ''
      : ` <Default Extension="config" ContentType="${CONFIG_CONTENT_TYPE}"/>\n`) +
    '</Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ` <Relationship Target="/${MODEL_PATH}" Id="rel0" Type="${MODEL_RELATIONSHIP}"/>\n` +
    '</Relationships>\n';
  const mtime = options.modified ?? new Date();
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    '[Content_Types].xml': [strToU8(contentTypes), { mtime }],
    '_rels/.rels': [strToU8(rels), { mtime }],
    [MODEL_PATH]: [strToU8(parts.join('')), { mtime }],
  };
  if (settings !== null) files[MODEL_SETTINGS_PATH] = [strToU8(settings), { mtime }];
  return zipSync(files, { level: 6 });
}

/**
 * `Metadata/model_settings.config` for a file with components: every object the build makes
 * (in id order) with its `name` and `extruder`, and for a components object each distinct object
 * it places as a `part` (by that object's id) with its `name` and `extruder`. The slot is the
 * colour group's position plus one; an uncoloured part has no `extruder` (the slicer's default),
 * and a components object takes the slot of its first coloured part.
 */
function modelSettings(
  objects: readonly ThreeMfObjectInput[],
  items: readonly ThreeMfBuildItem[],
  groupOf: readonly (number | null)[],
  idOf: (index: number) => number,
): string {
  const meta = (name: string, group: number | null | undefined, indent: string) =>
    `${indent}<metadata key="name" value="${xml(name)}"/>\n` +
    (group === null || group === undefined
      ? ''
      : `${indent}<metadata key="extruder" value="${group + 1}"/>\n`);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<config>\n'];
  const built = [...new Set(items.map((i) => i.object))].sort((a, b) => a - b);
  for (const index of built) {
    const o = objects[index]!;
    const partIndices = 'components' in o ? [...new Set(o.components.map((c) => c.object))] : [];
    const group =
      'components' in o
        ? (partIndices.map((p) => groupOf[p]).find((g) => g !== null && g !== undefined) ?? null)
        : groupOf[index];
    out.push(`  <object id="${idOf(index)}">\n`, meta(o.name, group, '    '));
    for (const p of partIndices) {
      out.push(`    <part id="${idOf(p)}" subtype="normal_part">\n`);
      out.push(meta(objects[p]!.name, groupOf[p], '      '), '    </part>\n');
    }
    out.push('  </object>\n');
  }
  out.push('</config>\n');
  return out.join('');
}

/** ` transform="..."`, or nothing for an absent or identity transform. */
function transformAttribute(m: Matrix3x4 | undefined): string {
  if (m === undefined || isIdentity(m)) return '';
  return ` transform="${m.map(matrixNum).join(' ')}"`;
}

/** A matrix entry to 1e-9 (a nanometre over a metre for rotation terms), without exponents. */
function matrixNum(v: number): string {
  const text = v.toFixed(9).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
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
  /** Empty for an object made of components. */
  mesh: TriMesh;
  /** The objects it is made of, placed; empty for a mesh object. */
  components: ThreeMfComponent[];
  /** The object's property group (`pid`) and index in it (`pindex`), or null where absent. */
  pid: number | null;
  pindex: number | null;
  /** The colour `pid` and `pindex` pick, when they name an entry of a colour group; else null. */
  color: string | null;
}

export interface ThreeMfComponent {
  objectId: number;
  /** The component's 3x4 transform as written (12 numbers), or null for identity. */
  transform: number[] | null;
}

export interface ThreeMfItem {
  objectId: number;
  /** The item's 3x4 transform as written (12 numbers), or null for identity. */
  transform: number[] | null;
}

/** A materials-extension colour group: its id, its colours as written, and its namespace. */
export interface ThreeMfColorGroup {
  id: number;
  colors: string[];
  /** The namespace its prefix is bound to on `<model>`, or null if the prefix is not declared. */
  namespace: string | null;
}

/** An object in `Metadata/model_settings.config`, and its parts, with their metadata. */
export interface ThreeMfSettingsObject {
  id: number;
  metadata: Record<string, string>;
  parts: { id: number; subtype: string; metadata: Record<string, string> }[];
}

export interface ParsedThreeMf {
  unit: ModelUnit;
  /** Every package entry, for checks. */
  entries: string[];
  /** The model part named by the root relationship. */
  modelPath: string;
  contentTypes: { extension: string; contentType: string }[];
  metadata: Record<string, string>;
  colorGroups: ThreeMfColorGroup[];
  /** Ids of the other property resources (base materials, textures, composites, multi). */
  otherPropertyIds: number[];
  objects: ThreeMfObject[];
  items: ThreeMfItem[];
  /** `Metadata/model_settings.config`, when the package has one. */
  modelSettings: ThreeMfSettingsObject[] | null;
}

export class ThreeMfParseError extends Error {
  override readonly name = 'ThreeMfParseError';
}

/**
 * Parse the subset this package writes: mesh and components objects, colour groups and the
 * objects' `pid` and `pindex`, build items, and `Metadata/model_settings.config` if present.
 */
export function parse3mf(bytes: Uint8Array): ParsedThreeMf {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new ThreeMfParseError(`not a zip package: ${e instanceof Error ? e.message : String(e)}`);
  }
  const entries = Object.keys(files).sort();
  const find = (path: string) => files[path] ?? files[path.replace(/^\//, '')];
  const text = (path: string): string => {
    const f = find(path);
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
  const modelAttributes = attributes(modelTag[1]!);
  const unit = (modelAttributes.unit ?? 'millimeter') as ModelUnit;
  const namespaceOf = (prefix: string | undefined) =>
    modelAttributes[prefix ? `xmlns:${prefix}` : 'xmlns'] ?? null;
  const metadata: Record<string, string> = {};
  for (const m of model.matchAll(/<(?:\w+:)?metadata\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?metadata>/g)) {
    const name = attributes(m[1]!).name;
    if (name) metadata[name] = unxml(m[2]!.trim());
  }

  const colorGroups: ThreeMfColorGroup[] = [];
  for (const m of model.matchAll(
    /<(?:(\w+):)?colorgroup\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?colorgroup>)/g,
  )) {
    colorGroups.push({
      id: Number(attributes(m[2]!).id),
      colors: [...(m[3] ?? '').matchAll(tag('color'))].map((c) => attributes(c[1]!).color ?? ''),
      namespace: namespaceOf(m[1]),
    });
  }
  const otherPropertyIds = [
    ...model.matchAll(
      /<(?:\w+:)?(?:basematerials|texture2dgroup|compositematerials|multiproperties)\b([^>]*?)\/?>/g,
    ),
  ].map((m) => Number(attributes(m[1]!).id));

  const objects: ThreeMfObject[] = [];
  for (const m of model.matchAll(/<(?:\w+:)?object\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?object>/g)) {
    const a = attributes(m[1]!);
    const body = m[2]!;
    const components = [...body.matchAll(tag('component'))].map((c) => {
      const ca = attributes(c[1]!);
      return { objectId: Number(ca.objectid), transform: transformOf(ca.transform) };
    });
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
    const pid = a.pid === undefined ? null : Number(a.pid);
    const pindex = a.pindex === undefined ? null : Number(a.pindex);
    const group = pid === null ? undefined : colorGroups.find((g) => g.id === pid);
    objects.push({
      id: Number(a.id),
      name: unxml(a.name ?? ''),
      type: a.type ?? 'model',
      mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) },
      components,
      pid,
      pindex,
      color: (group && pindex !== null && group.colors[pindex]) || null,
    });
  }
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(model)?.[1] ?? '';
  const items = [...build.matchAll(tag('item'))].map((m) => {
    const a = attributes(m[1]!);
    return { objectId: Number(a.objectid), transform: transformOf(a.transform) };
  });
  const settings = find(MODEL_SETTINGS_PATH);
  const modelSettings = settings ? parseModelSettings(strFromU8(settings)) : null;
  return {
    unit,
    entries,
    modelPath,
    contentTypes,
    metadata,
    colorGroups,
    otherPropertyIds,
    objects,
    items,
    modelSettings,
  };
}

/** The objects of a `model_settings.config` (plates and the rest are skipped). */
function parseModelSettings(config: string): ThreeMfSettingsObject[] {
  const metadataOf = (block: string) => {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(tag('metadata'))) {
      const a = attributes(m[1]!);
      if (a.key !== undefined) out[a.key] = unxml(a.value ?? '');
    }
    return out;
  };
  const partPattern = /<part\b([^>]*?)(?:\/>|>([\s\S]*?)<\/part>)/g;
  const out: ThreeMfSettingsObject[] = [];
  for (const m of config.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const body = m[2]!;
    out.push({
      id: Number(attributes(m[1]!).id),
      metadata: metadataOf(body.replace(partPattern, '')),
      parts: [...body.matchAll(partPattern)].map((p) => {
        const pa = attributes(p[1]!);
        return { id: Number(pa.id), subtype: pa.subtype ?? '', metadata: metadataOf(p[2] ?? '') };
      }),
    });
  }
  return out;
}

function transformOf(text: string | undefined): number[] | null {
  return text && text.trim() ? text.trim().split(/\s+/).map(Number) : null;
}

/** A mesh the build makes, in world coordinates, with its object's colour. */
export interface ThreeMfBuiltMesh extends NamedMesh {
  color: string | null;
}

/**
 * The meshes the build makes, in world coordinates: every item's object, components resolved
 * through their transforms, each named after (and coloured as) the object that holds the mesh.
 * Throws `ThreeMfParseError` on a reference to a missing object or a cycle of components.
 */
export function buildMeshes(parsed: ParsedThreeMf): ThreeMfBuiltMesh[] {
  const byId = new Map(parsed.objects.map((o) => [o.id, o]));
  const out: ThreeMfBuiltMesh[] = [];
  const visit = (id: number, m: Matrix3x4, path: number[]) => {
    const o = byId.get(id);
    if (!o) throw new ThreeMfParseError(`object ${id} does not exist`);
    if (path.includes(id)) throw new ThreeMfParseError(`object ${id} contains itself`);
    if (o.components.length === 0) {
      out.push({ name: o.name, mesh: transformMesh(o.mesh, m), color: o.color });
      return;
    }
    for (const c of o.components) {
      visit(c.objectId, c.transform ? composeMatrices(c.transform, m) : m, [...path, id]);
    }
  };
  for (const item of parsed.items) {
    visit(item.objectId, item.transform ?? IDENTITY_MATRIX, []);
  }
  return out;
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
  /** Per mesh object, its manifold check (objects made of components have none). */
  objects: { id: number; name: string; manifold: ManifoldReport }[];
}

/**
 * Structural checks a slicer relies on: the package parts and content types, unit millimetre,
 * resource ids unique, every mesh object a closed, consistently wound, outward mesh with triangle
 * indices in range, every components object naming objects defined before it, every build item
 * naming an object, every transform rigid (12 finite numbers, a rotation and a move: no mirror,
 * scale or shear); colour groups in the materials namespace, holding `#RRGGBB` or `#RRGGBBAA`
 * colours, and every object `pid` naming a property group (with a `pindex` inside a colour
 * group); and in `Metadata/model_settings.config`, every object and part naming an object and a
 * component of it, every `extruder` a slot number from 1.
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
  const checkTransform = (t: number[] | null, what: string) => {
    if (t === null) return;
    const problem = transformProblem(t);
    if (problem === 'malformed') problems.push(`${what}: the transform is not 12 numbers`);
    else if (problem === 'mirrors') {
      problems.push(`${what}: the transform mirrors or flattens the object`);
    } else if (problem === 'not rigid') {
      problems.push(`${what}: the transform scales or shears the object (it is not rigid)`);
    }
  };

  const resourceIds = new Set<number>();
  const claim = (id: number, what: string) => {
    if (resourceIds.has(id)) problems.push(`resource id ${id} is used twice (${what})`);
    resourceIds.add(id);
  };
  for (const g of parsed.colorGroups) {
    claim(g.id, `colour group ${g.id}`);
    if (g.namespace !== MATERIALS_NAMESPACE) {
      problems.push(`colour group ${g.id} is not in the materials namespace`);
    }
    if (g.colors.length === 0) problems.push(`colour group ${g.id} has no colours`);
    for (const c of g.colors) {
      if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) {
        problems.push(`colour group ${g.id}: ${c || 'an empty value'} is not a colour`);
      }
    }
  }
  for (const id of parsed.otherPropertyIds) claim(id, `property group ${id}`);

  const allObjectIds = new Set(parsed.objects.map((o) => o.id));
  const ids = new Set<number>();
  const objects: ThreeMfReport['objects'] = [];
  for (const o of parsed.objects) {
    if (ids.has(o.id)) problems.push(`object id ${o.id} is used twice`);
    else claim(o.id, `object ${o.id}`);
    checkProperties(o, parsed, problems);
    const vertices = o.mesh.positions.length / 3;
    if (o.components.length > 0) {
      if (o.mesh.indices.length > 0 || vertices > 0) {
        problems.push(`object ${o.id} has both a mesh and components`);
      }
      for (const c of o.components) {
        // Resources are defined before they are used, so this also rules out cycles.
        if (!allObjectIds.has(c.objectId)) {
          problems.push(
            `object ${o.id}: a component names object ${c.objectId}, which does not exist`,
          );
        } else if (!ids.has(c.objectId)) {
          problems.push(
            `object ${o.id}: a component names object ${c.objectId}, which is not defined before it`,
          );
        }
        checkTransform(c.transform, `object ${o.id}: the component of object ${c.objectId}`);
      }
      ids.add(o.id);
      continue;
    }
    ids.add(o.id);
    if (o.mesh.indices.some((i) => i >= vertices)) {
      problems.push(`object ${o.id}: a triangle names a vertex that does not exist`);
    }
    const manifold = checkManifold(o.mesh);
    for (const p of manifold.problems) problems.push(`object ${o.id} (${o.name}): ${p}`);
    objects.push({ id: o.id, name: o.name, manifold });
  }
  if (parsed.items.length === 0) problems.push('the build has no items');
  for (const item of parsed.items) {
    if (!ids.has(item.objectId))
      problems.push(`a build item names object ${item.objectId}, which does not exist`);
    checkTransform(item.transform, `the build item of object ${item.objectId}`);
  }
  if (parsed.modelSettings !== null) checkModelSettings(parsed, problems);
  return { ok: problems.length === 0, problems, parsed, objects };
}

/** An object's `pid` and `pindex`: a property group that exists, an index inside a colour group. */
function checkProperties(o: ThreeMfObject, parsed: ParsedThreeMf, problems: string[]) {
  if (o.pid === null) {
    if (o.pindex !== null) problems.push(`object ${o.id} has a pindex without a pid`);
    return;
  }
  const group = parsed.colorGroups.find((g) => g.id === o.pid);
  if (!group && !parsed.otherPropertyIds.includes(o.pid)) {
    problems.push(`object ${o.id}: pid ${o.pid} names no property group`);
    return;
  }
  if (o.pindex === null) {
    problems.push(`object ${o.id} has a pid without a pindex`);
  } else if (
    group &&
    !(Number.isInteger(o.pindex) && o.pindex >= 0 && o.pindex < group.colors.length)
  ) {
    problems.push(`object ${o.id}: pindex ${o.pindex} is outside colour group ${group.id}`);
  }
}

/** `model_settings.config`: objects that exist, parts that are their components, slots from 1. */
function checkModelSettings(parsed: ParsedThreeMf, problems: string[]) {
  const byId = new Map(parsed.objects.map((o) => [o.id, o]));
  const where = MODEL_SETTINGS_PATH;
  const checkExtruder = (metadata: Record<string, string>, what: string) => {
    const e = metadata.extruder;
    if (e !== undefined && !/^[1-9]\d*$/.test(e)) {
      problems.push(`${where}: ${what} has extruder ${e}, not a slot number from 1`);
    }
  };
  for (const s of parsed.modelSettings ?? []) {
    const o = byId.get(s.id);
    if (!o) {
      problems.push(`${where} names object ${s.id}, which does not exist`);
      continue;
    }
    checkExtruder(s.metadata, `object ${s.id}`);
    for (const p of s.parts) {
      // A mesh object's parts are numbered by the slicer (its volumes), not by object id.
      if (o.components.length > 0 && !o.components.some((c) => c.objectId === p.id)) {
        problems.push(`${where}: object ${s.id} has no component object ${p.id}`);
      }
      checkExtruder(p.metadata, `part ${p.id} of object ${s.id}`);
    }
  }
}
