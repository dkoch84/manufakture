// The slicer interop fixtures (M3 plan, T3.0a): small 3MF packages that each try one way of
// writing a two-body model (a red box and a blue box), so the slicers' command lines and GUIs
// can be asked what they make of it. They are written here by hand, not by `write3mf`, because
// some hold markup the writer never produces (per-triangle colours, a bare components object, a
// `model_settings.config` beside plain objects, one object placed twice). Since T3.3a the writer
// produces 01 (no colours), 02, 06 and 07 byte for byte, the layouts the slicers keep;
// `src/fixtures/slicers/fixtures.test.ts` checks that, that every fixture is a valid 3MF, and
// that the committed files are what this script builds.
//
//   node scripts/slicer-fixtures.ts           (from packages/io) writes src/fixtures/slicers/
//   pnpm --filter @manufakture/io fixtures:slicers
//
// Plain Node (type stripping): only fflate and Node built-ins are imported, so no build step.

import { strToU8, zipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const MATERIALS_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
export const MODEL_SETTINGS_PATH = 'Metadata/model_settings.config';

/**
 * Zip entry dates, fixed so the fixtures are byte-for-byte reproducible. Built from LOCAL fields
 * on purpose: fflate writes the DOS date and time from the Date's local getters (getFullYear,
 * getHours, ...), so a UTC instant would encode differently in every time zone and the committed
 * fixtures would only match where they were generated. Local fields encode the same everywhere.
 */
const MODIFIED = new Date(2026, 0, 1, 0, 0, 0);

export const RED = '#FF0000';
export const BLUE = '#0000FF';

type Vec3 = [number, number, number];

/** A box as `write3mf` gets it from the test helpers: 8 vertices, 12 triangles, wound outward. */
interface Box {
  name: string;
  min: Vec3;
  size: Vec3;
}

/** 20 x 20 x 10 mm and 30 x 15 x 8 mm, side by side near the middle of a 256 mm bed. */
export const RED_BOX: Box = { name: 'Red box', min: [90, 120, 0], size: [20, 20, 10] };
export const BLUE_BOX: Box = { name: 'Blue box', min: [130, 122.5, 0], size: [30, 15, 8] };

/** Triangle indices of the top (+z) face in `boxXml`'s triangle order. */
export const TOP_FACE_TRIANGLES = [2, 3];

// Every mesh fixture uses this vertex and triangle order (the io test helper's `boxMesh`).
function boxVertices({ min, size }: Pick<Box, 'min' | 'size'>): Vec3[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = [x0 + size[0], y0 + size[1], z0 + size[2]];
  return [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
}

// prettier-ignore
const BOX_TRIANGLES: Vec3[] = [
  [0, 2, 1], [0, 3, 2], // bottom (-z)
  [4, 5, 6], [4, 6, 7], // top (+z)
  [0, 1, 5], [0, 5, 4], // front (-y)
  [2, 3, 7], [2, 7, 6], // back (+y)
  [1, 2, 6], [1, 6, 5], // right (+x)
  [3, 0, 4], [3, 4, 7], // left (-x)
];

/** A coordinate as `write3mf` writes it: to a nanometre, no exponent. */
function num(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

interface MeshObject {
  id: number;
  name: string;
  box: Pick<Box, 'min' | 'size'>;
  /** Object-level property group and index (materials extension). */
  pid?: number;
  pindex?: number;
  /** Per-triangle overrides: triangle index to `pid` and `p1` (one colour for the triangle). */
  triangleProps?: Map<number, { pid: number; p1: number }>;
}

interface ComponentsObject {
  id: number;
  name: string;
  components: { objectId: number; transform?: string }[];
}

interface ColorGroup {
  id: number;
  colors: string[];
}

interface ModelSpec {
  /** Declare the materials namespace with the prefix `m`. */
  materials?: boolean;
  colorGroups?: ColorGroup[];
  objects: (MeshObject | ComponentsObject)[];
  items: { objectId: number; transform?: string }[];
}

function modelXml(spec: ModelSpec): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const ns = spec.materials ? ` xmlns:m="${MATERIALS_NS}"` : '';
  out.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}"${ns}>\n`);
  out.push(' <metadata name="Application">manufakture</metadata>\n');
  out.push(' <resources>\n');
  for (const g of spec.colorGroups ?? []) {
    out.push(`  <m:colorgroup id="${g.id}">\n`);
    for (const c of g.colors) out.push(`   <m:color color="${c}"/>\n`);
    out.push('  </m:colorgroup>\n');
  }
  for (const o of spec.objects) {
    if ('components' in o) {
      out.push(`  <object id="${o.id}" name="${o.name}" type="model">\n   <components>\n`);
      for (const c of o.components) {
        const t = c.transform ? ` transform="${c.transform}"` : '';
        out.push(`    <component objectid="${c.objectId}"${t}/>\n`);
      }
      out.push('   </components>\n  </object>\n');
      continue;
    }
    const props =
      o.pid === undefined
        ? ''
        : ` pid="${o.pid}"${o.pindex === undefined ? '' : ` pindex="${o.pindex}"`}`;
    out.push(`  <object id="${o.id}" name="${o.name}" type="model"${props}>\n`);
    out.push('   <mesh>\n    <vertices>\n');
    for (const [x, y, z] of boxVertices(o.box)) {
      out.push(`     <vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>\n`);
    }
    out.push('    </vertices>\n    <triangles>\n');
    BOX_TRIANGLES.forEach(([v1, v2, v3], i) => {
      const p = o.triangleProps?.get(i);
      const tp = p ? ` pid="${p.pid}" p1="${p.p1}"` : '';
      out.push(`     <triangle v1="${v1}" v2="${v2}" v3="${v3}"${tp}/>\n`);
    });
    out.push('    </triangles>\n   </mesh>\n  </object>\n');
  }
  out.push(' </resources>\n <build>\n');
  for (const item of spec.items) {
    const t = item.transform ? ` transform="${item.transform}"` : '';
    out.push(`  <item objectid="${item.objectId}"${t}/>\n`);
  }
  out.push(' </build>\n</model>\n');
  return out.join('');
}

/** Bambu's per-object settings file: objects, their metadata, and parts (component ids). */
interface SettingsObject {
  id: number;
  metadata: Record<string, string>;
  parts?: { id: number; metadata: Record<string, string> }[];
}

function modelSettingsXml(objects: SettingsObject[]): string {
  const meta = (m: Record<string, string>, indent: string) =>
    Object.entries(m).map(([k, v]) => `${indent}<metadata key="${k}" value="${v}"/>\n`);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>\n', '<config>\n'];
  for (const o of objects) {
    out.push(`  <object id="${o.id}">\n`, ...meta(o.metadata, '    '));
    for (const p of o.parts ?? []) {
      out.push(`    <part id="${p.id}" subtype="normal_part">\n`, ...meta(p.metadata, '      '));
      out.push('    </part>\n');
    }
    out.push('  </object>\n');
  }
  out.push('</config>\n');
  return out.join('');
}

function packageOf(model: string, extra: Record<string, string> = {}): Uint8Array {
  const hasConfig = Object.keys(extra).some((p) => p.endsWith('.config'));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    (hasConfig ? ' <Default Extension="config" ContentType="text/xml"/>\n' : '') +
    '</Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    '[Content_Types].xml': [strToU8(contentTypes), { mtime: MODIFIED }],
    '_rels/.rels': [strToU8(rels), { mtime: MODIFIED }],
    '3D/3dmodel.model': [strToU8(model), { mtime: MODIFIED }],
  };
  for (const [path, text] of Object.entries(extra)) {
    files[path] = [strToU8(text), { mtime: MODIFIED }];
  }
  return zipSync(files, { level: 6 });
}

/** One fixture: its file name, what it tests, and what each slicer is expected to show. */
export interface SlicerFixture {
  file: string;
  title: string;
  /** What the file holds beyond the core, in a sentence. */
  holds: string;
  bytes: Uint8Array;
}

/** 90 degrees about +x (3MF row-vector matrix), then a move onto the bed. */
export const ROTATED_TRANSFORM = '1 0 0 0 0 1 0 -1 0 90 135 0';
/** A move only. */
export const TRANSLATED_TRANSFORM = '1 0 0 0 1 0 0 0 1 130 122.5 0';

export function buildSlicerFixtures(): SlicerFixture[] {
  const red = { name: RED_BOX.name, box: RED_BOX };
  const blue = { name: BLUE_BOX.name, box: BLUE_BOX };
  const twoGroups: ColorGroup[] = [
    { id: 1, colors: [RED] },
    { id: 2, colors: [BLUE] },
  ];
  const fixtures: SlicerFixture[] = [];
  const add = (file: string, title: string, holds: string, bytes: Uint8Array) =>
    fixtures.push({ file, title, holds, bytes });

  add(
    '01-core.3mf',
    'Core only',
    'what `write3mf` writes today: two mesh objects, two build items, no colours',
    packageOf(
      modelXml({
        objects: [
          { id: 1, ...red },
          { id: 2, ...blue },
        ],
        items: [{ objectId: 1 }, { objectId: 2 }],
      }),
    ),
  );

  add(
    '02-colorgroups.3mf',
    'Colour groups',
    'M3 decision 12: one `m:colorgroup` per colour with one `m:color`, `pid` and `pindex="0"` on each object',
    packageOf(
      modelXml({
        materials: true,
        colorGroups: twoGroups,
        objects: [
          { id: 3, ...red, pid: 1, pindex: 0 },
          { id: 4, ...blue, pid: 2, pindex: 0 },
        ],
        items: [{ objectId: 3 }, { objectId: 4 }],
      }),
    ),
  );

  add(
    '03-components.3mf',
    'One component object',
    'colour groups as in 02 on the two mesh objects, and one object "Two boxes" made of both as components; one build item',
    packageOf(
      modelXml({
        materials: true,
        colorGroups: twoGroups,
        objects: [
          { id: 3, ...red, pid: 1, pindex: 0 },
          { id: 4, ...blue, pid: 2, pindex: 0 },
          { id: 5, name: 'Two boxes', components: [{ objectId: 3 }, { objectId: 4 }] },
        ],
        items: [{ objectId: 5 }],
      }),
    ),
  );

  add(
    '04-pindex-triangles.3mf',
    'pindex and per-triangle colours',
    'one colour group holding both colours: the red box `pindex="0"`, the blue box `pindex="1"`, and the red box\'s top face (two triangles) blue by `pid` and `p1`',
    packageOf(
      modelXml({
        materials: true,
        colorGroups: [{ id: 1, colors: [RED, BLUE] }],
        objects: [
          {
            id: 2,
            ...red,
            pid: 1,
            pindex: 0,
            triangleProps: new Map(TOP_FACE_TRIANGLES.map((t) => [t, { pid: 1, p1: 1 }])),
          },
          { id: 3, ...blue, pid: 1, pindex: 1 },
        ],
        items: [{ objectId: 2 }, { objectId: 3 }],
      }),
    ),
  );

  add(
    '05-model-settings.3mf',
    'model_settings.config only',
    'core as in 01 (no colour groups) plus a minimal `Metadata/model_settings.config` giving each object its name and `extruder` 1 and 2',
    packageOf(
      modelXml({
        objects: [
          { id: 1, ...red },
          { id: 2, ...blue },
        ],
        items: [{ objectId: 1 }, { objectId: 2 }],
      }),
      {
        [MODEL_SETTINGS_PATH]: modelSettingsXml([
          { id: 1, metadata: { name: RED_BOX.name, extruder: '1' } },
          { id: 2, metadata: { name: BLUE_BOX.name, extruder: '2' } },
        ]),
      },
    ),
  );

  // The boxes are modelled at the origin; the build items place them. The red box is turned
  // 90 degrees about x (it then stands 20 mm tall instead of 10) and moved; the blue one moved.
  add(
    '06-transforms.3mf',
    'Build-item transforms',
    "colour groups as in 02, both boxes modelled at the origin; the red box's item turns it 90 degrees about x and moves it, the blue box's item only moves it",
    packageOf(
      modelXml({
        materials: true,
        colorGroups: twoGroups,
        objects: [
          {
            id: 3,
            name: RED_BOX.name,
            box: { min: [0, 0, 0], size: RED_BOX.size },
            pid: 1,
            pindex: 0,
          },
          {
            id: 4,
            name: BLUE_BOX.name,
            box: { min: [0, 0, 0], size: BLUE_BOX.size },
            pid: 2,
            pindex: 0,
          },
        ],
        items: [
          { objectId: 3, transform: ROTATED_TRANSFORM },
          { objectId: 4, transform: TRANSLATED_TRANSFORM },
        ],
      }),
    ),
  );

  add(
    '07-components-model-settings.3mf',
    'Components with model_settings.config',
    '03 plus a `Metadata/model_settings.config` naming the component object and giving each part (by component object id) its name and `extruder`',
    packageOf(
      modelXml({
        materials: true,
        colorGroups: twoGroups,
        objects: [
          { id: 3, ...red, pid: 1, pindex: 0 },
          { id: 4, ...blue, pid: 2, pindex: 0 },
          { id: 5, name: 'Two boxes', components: [{ objectId: 3 }, { objectId: 4 }] },
        ],
        items: [{ objectId: 5 }],
      }),
      {
        [MODEL_SETTINGS_PATH]: modelSettingsXml([
          {
            id: 5,
            metadata: { name: 'Two boxes', extruder: '1' },
            parts: [
              { id: 3, metadata: { name: RED_BOX.name, extruder: '1' } },
              { id: 4, metadata: { name: BLUE_BOX.name, extruder: '2' } },
            ],
          },
        ]),
      },
    ),
  );

  // Not in the plan's list: what an assembly export (T2.3f) writes for a part placed twice.
  add(
    '08-instances.3mf',
    'One object, two build items',
    'colour groups as in 02, both boxes modelled at the origin; the red box placed once, the blue box (slot 2, so a lost colour shows) placed twice by two build items, as an assembly with two instances of one part is written',
    packageOf(
      modelXml({
        materials: true,
        colorGroups: twoGroups,
        objects: [
          {
            id: 3,
            name: RED_BOX.name,
            box: { min: [0, 0, 0], size: RED_BOX.size },
            pid: 1,
            pindex: 0,
          },
          {
            id: 4,
            name: BLUE_BOX.name,
            box: { min: [0, 0, 0], size: BLUE_BOX.size },
            pid: 2,
            pindex: 0,
          },
        ],
        items: [
          { objectId: 3, transform: '1 0 0 0 1 0 0 0 1 90 120 0' },
          { objectId: 4, transform: TRANSLATED_TRANSFORM },
          { objectId: 4, transform: '1 0 0 0 1 0 0 0 1 130 150 0' },
        ],
      }),
    ),
  );

  return fixtures;
}

export const FIXTURES_DIR = new URL('../src/fixtures/slicers/', import.meta.url);

// Run as a script: write the fixtures.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const f of buildSlicerFixtures()) {
    writeFileSync(new URL(f.file, FIXTURES_DIR), f.bytes);
    console.log(`${f.file}  ${f.bytes.length} bytes  ${f.title}`);
  }
}
