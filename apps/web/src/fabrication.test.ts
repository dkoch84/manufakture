// @vitest-environment node
/// <reference types="node" />
// Every fabrication format (M8 plan T8.1b, cross-cutting decision 5) exported in Node from the
// e2e fixtures, through the packages' entry points that `@manufakture/io`'s README lists under
// "Fabrication exports": the M4 bookshelf (a cabinet of boards and joints) and the M6 shed
// regenerated with the real kernel, solver, text engine and domains, as a headless session would,
// with no browser and no app state. The app's panels write through the same functions, so the
// files are the ones the app saves.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportGcode, exportLaser, withPost } from '@manufakture/cam/export';
import {
  applyCommand,
  createDocument,
  type CamOperation,
  type CamTool,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { DISCLAIMER_SHORT, registerConstruction } from '@manufakture/domain-construction';
import { exportTakeoff } from '@manufakture/domain-construction/files';
import { registerWood } from '@manufakture/domain-wood';
import { exportCutList } from '@manufakture/domain-wood/files';
import {
  drawingFile,
  exportBodyFiles,
  kernelExchanger,
  memberExportBodies,
  parseStl,
  UNREVIEWED_EXPORT,
  stepProductNames,
  validate3mf,
} from '@manufakture/io';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  ExtensionRegistry,
  RegenEngine,
  createTextOutliner,
  type RegenResult,
} from '@manufakture/regen';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { registerStock } from '@manufakture/stock';
import { csvTextField } from '@manufakture/takeoff';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOARDS,
  INCH_UNITS,
  JOINTS,
  PANEL_DEPTH,
  SHELF,
  assemblyCommands,
  boardFeature,
  boardNames,
  carcassSketches,
  configurationCommands,
  frameSketch,
  jointFeature,
  panelLength,
} from '../e2e/m4-fixtures';
import { FT_IN_UNITS, SHED } from '../e2e/shed-fixture';
import { addSetupCommand } from './cam/commands';
import { constructionSetCommand } from './construction/drawings/set';
import { insertViewCommand, newDrawingCommand } from './drawing/model';

const PART = 'part#1';
/** The branch every file here is exported from: main (the export gate, T8.3c). */
const MAIN = { id: 'main' };
const mm = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });
const inch = (source: string): StoredExpression => ({
  source,
  lengthUnit: 'in',
  angleUnit: 'deg',
});

function apply(doc: ManufaktureDocument, commands: readonly unknown[]): ManufaktureDocument {
  for (const command of commands) {
    const r = applyCommand(doc, command as Command);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** The M4 acceptance bookshelf (apps/web/e2e/m4-fixtures.ts), as its spec builds it. */
function cabinet(): ManufaktureDocument {
  const add = (feature: unknown) => ({ type: 'addFeature', partId: PART, feature });
  return apply(createDocument({ id: 'cabinet', name: SHELF.name }), [
    INCH_UNITS,
    { type: 'renamePart', partId: PART, name: 'Carcass' },
    { type: 'setVariable', name: 'width', expression: inch(`${SHELF.modelled} in`) },
    add(frameSketch()),
    ...BOARDS.slice(0, 4).map((b) => add(boardFeature(b))),
    ...carcassSketches(),
    ...BOARDS.slice(4).map((b) => add(boardFeature(b))),
    ...JOINTS.map((j) => add(jointFeature(j))),
    ...boardNames(),
    ...configurationCommands(),
    ...assemblyCommands(),
  ]);
}

/** The M6 shed (apps/web/e2e/shed-fixture.ts). */
function shed(): ManufaktureDocument {
  return apply(createDocument({ id: 'shed', name: 'Shed' }), [FT_IN_UNITS, SHED]);
}

/** Node's `fetch` reads no `file:` URL: the bundled fonts are read from disk. */
async function readBundledFont(url: URL): Promise<Response> {
  if (url.protocol !== 'file:') throw new Error(`refusing to fetch ${url.href}`);
  return new Response(readFileSync(fileURLToPath(url)));
}

let kernel: KernelService;
let solver: SolverService;
const engines: RegenEngine[] = [];

beforeAll(async () => {
  kernel = await createNodeService();
  solver = createSolverService();
}, 120_000);

afterAll(async () => {
  for (const e of engines) await e.dispose();
});

/** A fresh engine with the domains the app's regen worker registers, and its first regen. */
async function regen(
  doc: ManufaktureDocument,
): Promise<{ engine: RegenEngine; result: RegenResult }> {
  const extensions = new ExtensionRegistry();
  registerStock(extensions);
  registerWood(extensions);
  registerConstruction(extensions);
  const engine = new RegenEngine({
    kernel,
    solver,
    text: createTextOutliner({ fetchImpl: readBundledFont }),
    extensions,
  });
  engines.push(engine);
  const s = kernel.stats();
  const generation = Math.max(0, s.generation, s.cancelledThrough) + 1;
  const result = await engine.regen(doc, { generation });
  if (result === null) throw new Error('the regen was superseded');
  return { engine, result };
}

/** Every body of the result, as the app names them for export (`<part id>/<body id>`). */
function bodiesOf(result: RegenResult, doc: ManufaktureDocument) {
  return result.parts.flatMap((p) => {
    const features = new Map(
      doc.parts.find((x) => x.id === p.partId)?.features.map((f) => [f.id, f.name]),
    );
    return p.bodies.map((b) => ({
      id: `${p.partId}/${b.bodyId}`,
      name: features.get(b.bodyId) ?? b.bodyId,
      shape: b.shape,
    }));
  });
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isPdf = (bytes: Uint8Array) => text(bytes.subarray(0, 5)) === '%PDF-';

/** The cabinet's shelf 1 as a CAM setup: two outside profiles of its top face, two tools. */
function withCam(
  doc: ManufaktureDocument,
  face: string,
): { doc: ManufaktureDocument; setupId: string } {
  const preset = {
    material: 'plywood',
    spindle: mm('18000rpm'),
    feed: mm('1500mm/min'),
    plunge: mm('500mm/min'),
    stepdown: mm('3'),
    stepover: mm('2'),
  };
  const tool = (id: string, number: number, diameter: string): CamTool => ({
    id,
    name: `${diameter} flat`,
    kind: 'flat',
    number,
    diameter: inch(diameter),
    fluteLength: mm('22'),
    flutes: 2,
    presets: [preset],
  });
  const profile = (id: string, toolId: string, name: string, ref: string) =>
    ({
      id,
      kind: 'profile',
      name,
      suppressed: false,
      tool: toolId,
      geometry: [{ kind: 'face', face: { id: ref, ref: { face } } }],
      side: 'outside',
      depth: { kind: 'through', extra: mm('0.5') },
      finishAllowance: mm('0'),
      entry: { kind: 'plunge' },
      leadIn: { kind: 'none' },
      leadOut: { kind: 'none' },
      climb: true,
    }) as CamOperation;
  const s = addSetupCommand(doc, PART, 'extension#9');
  const command = s.command as Extract<Command, { type: 'addCamSetup' }>;
  const setup = { ...command.setup, stock: { ...command.setup.stock, material: 'plywood' } };
  return {
    setupId: s.setupId,
    doc: apply(doc, [
      { type: 'addCamTool', tool: tool('tool#1', 201, '1/4') },
      { type: 'addCamTool', tool: tool('tool#2', 102, '1/8') },
      { type: 'addCamSetup', setup },
      {
        type: 'addCamOperation',
        setupId: s.setupId,
        operation: profile('profile#1', 'tool#2', 'Rough outline', 'r1'),
      },
      {
        type: 'addCamOperation',
        setupId: s.setupId,
        operation: profile('profile#2', 'tool#1', 'Outline', 'r2'),
      },
    ]),
  };
}

describe('fabrication exports in Node: the cabinet', () => {
  it('writes the cut list, the bill of materials and the shop PDF', async () => {
    const doc = cabinet();
    const { result } = await regen(doc);
    const sources = { document: doc, parts: result.parts, assemblies: result.assemblies };
    const list = await exportCutList('list', sources, { source: MAIN });
    expect([list.name, list.type]).toEqual([`${SHELF.name} cut list.csv`, 'text/csv']);
    const lines = text(list.bytes).split('\r\n');
    expect(lines[0]).toBe(
      '#,Item,Stock,Material,Length,Width,Thickness,Quantity,Total,Flags,Bodies',
    );
    // Every board of the cabinet is counted once, in some row.
    const bodies = lines.slice(1, -1).flatMap((l) => l.slice(l.lastIndexOf(',') + 1).split(' '));
    expect(bodies.sort()).toEqual(BOARDS.map((_, i) => `extension#${i + 1}`).sort());
    const bom = await exportCutList('bom', sources, { source: MAIN });
    expect(text(bom.bytes)).toContain('"3/4"" plywood (sheets to buy)",,1,');
    const pdf = await exportCutList(
      'pdf',
      { ...sources, assemblyId: 'assembly#1' },
      { source: MAIN },
    );
    expect([pdf.name, pdf.type, isPdf(pdf.bytes)]).toEqual([
      `${SHELF.name} cut list.pdf`,
      'application/pdf',
      true,
    ]);
  });

  it('writes STL, 3MF and STEP of its bodies, closed and named', async () => {
    const doc = cabinet();
    const { engine, result } = await regen(doc);
    const exchanger = kernelExchanger({
      kernel,
      generation: () => engine.generation,
      bodies: bodiesOf(result, doc),
    });
    const stl = await exportBodyFiles(exchanger, 'stl', { documentName: doc.name, source: MAIN });
    if (!stl.ok) throw new Error(stl.message);
    expect(stl.files.map((f) => f.name)).toEqual([`${SHELF.name}.stl`]);
    expect(parseStl(stl.files[0]!.bytes).mesh.indices.length).toBeGreaterThan(0);
    const each = await exportBodyFiles(exchanger, 'stl-each', {
      documentName: doc.name,
      source: MAIN,
    });
    expect(each.ok && each.files.length).toBe(BOARDS.length);
    const threemf = await exportBodyFiles(exchanger, '3mf', {
      documentName: doc.name,
      source: MAIN,
    });
    if (!threemf.ok) throw new Error(threemf.message);
    const report = validate3mf(threemf.files[0]!.bytes);
    expect(report.problems).toEqual([]);
    expect(report.objects.map((o) => o.name).sort()).toEqual(BOARDS.map((b) => b.name).sort());
    const step = await exportBodyFiles(exchanger, 'step', { documentName: doc.name, source: MAIN });
    if (!step.ok) throw new Error(step.message);
    expect([step.files[0]!.name, step.files[0]!.type]).toEqual([
      `${SHELF.name}.step`,
      'model/step',
    ]);
    expect(stepProductNames(step.files[0]!.bytes).sort()).toEqual(BOARDS.map((b) => b.name).sort());
  });

  it('writes a drawing as PDF, DXF and SVG', async () => {
    const d = newDrawingCommand(cabinet(), 'Carcass', {
      size: 'A3',
      orientation: 'landscape',
      title: { Title: 'Carcass' },
    });
    let doc = apply(cabinet(), [d.command]);
    for (const [i, direction] of (['front', 'top'] as const).entries()) {
      const drawing = doc.drawings!.find((x) => x.id === d.drawingId)!;
      const v = insertViewCommand(drawing, drawing.sheets[0]!, {
        source: { part: PART },
        direction,
        scale: { paper: mm('1'), model: mm('10') },
        position: [100 + 200 * i, 150],
        hidden: true,
        smooth: false,
      });
      doc = apply(doc, [v.command]);
    }
    const { engine } = await regen(doc);
    const drawing = doc.drawings!.find((x) => x.id === d.drawingId)!;
    const sheet = await engine.drawingSheet(doc, drawing.id, drawing.sheets[0]!.id);
    const names = { drawing: drawing.name, sheets: drawing.sheets.map((s) => s.name) };
    const pdf = drawingFile('pdf', [sheet?.display ?? null], names, MAIN);
    const dxf = drawingFile('dxf', [sheet?.display ?? null], names, MAIN);
    const svg = drawingFile('svg', [sheet?.display ?? null], names, MAIN);
    if (!pdf.ok || !dxf.ok || !svg.ok) throw new Error('a drawing file was refused');
    expect([pdf.fileName, isPdf(pdf.bytes)]).toEqual(['Carcass.pdf', true]);
    expect(dxf.fileName).toBe('Carcass - Sheet 1.dxf');
    expect(text(dxf.bytes)).toMatch(/^\s*0\r?\nSECTION/);
    expect(text(svg.bytes)).toContain('<svg');
  });

  it("writes G-code and its setup sheet, and the top face's outline for a laser", async () => {
    const base = cabinet();
    const { result } = await regen(base);
    const shelf = result.parts[0]!.bodies.find((b) => b.bodyId === 'extension#9')!;
    const top = shelf.topology!.faces.find((f) => f.normal !== null && f.normal[2] > 0.99)!;
    const face = result.names[shelf.mesh!.faceNames[top.index - 1]!]!;
    const { doc, setupId } = withCam(base, face);
    const { engine } = await regen(doc);
    const geometer = { geometry: engine.camGeometry.bind(engine) };
    const gcode = await exportGcode(doc, setupId, geometer, {
      date: '2026-10-08',
      source: MAIN,
      settings: (defaults) => ({ ...withPost(defaults, 'grbl'), multiTool: 'pause' }),
    });
    if (!gcode.ok) throw new Error(gcode.reasons.join('; '));
    expect(gcode.files.map((f) => [f.name, f.type])).toEqual([
      [`${SHELF.name} - Setup 1.nc`, 'text/plain'],
    ]);
    const program = text(gcode.files[0]!.bytes);
    expect(program).toContain('G21');
    expect(program.match(/^M0\b/gm)).toHaveLength(1);
    expect(gcode.sheet).toContain('Rough outline');
    const perTool = await exportGcode(doc, setupId, geometer, {
      date: '2026-10-08',
      source: MAIN,
      settings: (defaults) => withPost(defaults, 'grbl'),
    });
    expect(perTool.ok && perTool.files.map((f) => f.type)).toEqual(['application/zip']);

    const laser = await exportLaser(
      doc,
      { partId: PART, body: 'extension#9', viewId: `${PART}/extension#9` },
      [{ kind: 'face', ref: { face }, label: 'Shelf top', layer: 'outline' }],
      { geometer },
      { format: 'dxf', kerf: 0.2, baseName: 'Shelf 1', source: MAIN },
    );
    if (!laser.ok) throw new Error(laser.messages.join('; '));
    expect([laser.file.name, laser.file.type]).toEqual(['Shelf 1.dxf', 'application/dxf']);
    // The shelf's top (its blank's length by the panels' depth), grown by half the kerf all round.
    const sides = [laser.size.width, laser.size.height].sort((a, b) => b - a);
    expect(sides[0]).toBeCloseTo(panelLength(SHELF.modelled) * 25.4 + 0.2, 6);
    expect(sides[1]).toBeCloseTo(PANEL_DEPTH * 25.4 + 0.2, 6);
  });
});

describe('fabrication exports in Node: the shed', () => {
  it('writes the takeoff CSV and PDF, each with the disclaimer', async () => {
    const doc = shed();
    const { result } = await regen(doc);
    const part = result.parts[0]!;
    const sets = (part.members ?? []).map((s) => ({ namespace: s.namespace, members: s.members! }));
    const sources = { document: doc, partId: PART, features: part.features, sets };
    const csv = exportTakeoff('csv', sources, MAIN);
    expect([csv.name, csv.type]).toEqual(['Shed takeoff.csv', 'text/csv']);
    const lines = text(csv.bytes).split('\r\n');
    expect(lines.slice(0, 2)).toEqual(['Takeoff: Shed', csvTextField(DISCLAIMER_SHORT)]);
    expect(lines.some((l) => l.startsWith('Lumber to buy,'))).toBe(true);
    const pdf = exportTakeoff('pdf', sources, MAIN);
    expect([pdf.name, isPdf(pdf.bytes)]).toEqual(['Shed takeoff.pdf', true]);
  });

  it('writes STL and 3MF with the framing members, and STEP with them as B-reps', async () => {
    const doc = shed();
    const { engine, result } = await regen(doc);
    const part = result.parts[0]!;
    const meshes = new Map((result.memberMeshes?.added ?? []).map((m) => [m.key, m]));
    const members = memberExportBodies({
      meshes,
      sets: (part.members ?? []).map((s) => ({ instances: s.instances ?? [] })),
    });
    expect(members.length).toBeGreaterThan(100);
    const exchanger = kernelExchanger({
      kernel,
      generation: () => engine.generation,
      bodies: bodiesOf(result, doc),
      memberBodies: (partId, ids, options) => engine.memberBodies(partId, ids, options),
    });
    const options = { documentName: doc.name, members, partId: PART, source: MAIN };
    const threemf = await exportBodyFiles(exchanger, '3mf', options);
    if (!threemf.ok) throw new Error(threemf.message);
    const report = validate3mf(threemf.files[0]!.bytes);
    expect(report.problems).toEqual([]);
    expect(report.objects).toHaveLength(part.bodies.length + members.length);
    const each = await exportBodyFiles(exchanger, 'stl-each', options);
    expect(each.ok && each.files.at(-1)!.name).toBe('Shed members.stl');
    const step = await exportBodyFiles(exchanger, 'step', {
      ...options,
      stepDescription: DISCLAIMER_SHORT,
    });
    if (!step.ok) throw new Error(step.message);
    expect(step.note).toBe(` ${members.length} framing members as B-reps.`);
    const products = stepProductNames(step.files[0]!.bytes);
    expect(products).toHaveLength(part.bodies.length + members.length);
    expect(text(step.files[0]!.bytes)).toContain(
      `FILE_DESCRIPTION(('${DISCLAIMER_SHORT.split(' ')[0]}`,
    );
  });

  it('writes its construction drawing set as one PDF', async () => {
    const d = newDrawingCommand(shed(), 'Shed set', {
      size: 'A3',
      orientation: 'landscape',
      title: { Title: 'Shed' },
    });
    let doc = apply(shed(), [d.command]);
    const drawing = doc.drawings!.find((x) => x.id === d.drawingId)!;
    const set = constructionSetCommand(doc, drawing, drawing.sheets[0], {
      part: PART,
      size: 'A3',
      orientation: 'landscape',
      planScale: 'auto',
      framingScale: 'auto',
    });
    if (!set.ok) throw new Error(set.message);
    doc = apply(doc, [set.command]);
    const { engine } = await regen(doc);
    const sheets = doc.drawings!.find((x) => x.id === d.drawingId)!.sheets;
    expect(sheets.length).toBeGreaterThan(5);
    const lists = [];
    for (const s of sheets)
      lists.push((await engine.drawingSheet(doc, d.drawingId, s.id))?.display ?? null);
    const pdf = drawingFile(
      'pdf',
      lists,
      { drawing: 'Shed set', sheets: sheets.map((s) => s.name) },
      MAIN,
    );
    if (!pdf.ok) throw new Error(pdf.message);
    expect([pdf.fileName, isPdf(pdf.bytes)]).toEqual(['Shed set.pdf', true]);
    expect(text(pdf.bytes)).toContain(`/Count ${sheets.length}`);
  });
});

describe('fabrication exports in Node: the export gate', () => {
  const agent = (review: string) => ({
    id: 'branch-1',
    provenance: { origin: 'agent' as const, review },
  });
  const REFUSED = ['open', 'submitted', 'changes-requested', 'rejected'];
  const refusing = {
    bodies: () => {
      throw new Error('the kernel was asked');
    },
    tessellate: () => Promise.reject(new Error('the kernel was asked')),
    exportStep: () => Promise.reject(new Error('the kernel was asked')),
  };
  const asked = {
    geometry: () => Promise.reject(new Error('the geometry stage was asked')),
  };

  it('refuses every format from an agent’s unreviewed branch, before any work', async () => {
    const doc = cabinet();
    for (const review of REFUSED) {
      const source = agent(review);
      await expect(exportCutList('list', { document: doc, parts: [] }, { source })).rejects.toThrow(
        UNREVIEWED_EXPORT,
      );
      expect(() =>
        exportTakeoff('csv', { document: doc, partId: PART, features: [], sets: [] }, source),
      ).toThrow(UNREVIEWED_EXPORT);
      expect(await exportGcode(doc, 'setup#1', asked, { date: 'x', source })).toEqual({
        ok: false,
        reasons: [UNREVIEWED_EXPORT],
      });
      expect(
        await exportLaser(
          doc,
          { partId: PART, body: 'extension#9', viewId: 'v' },
          [],
          { geometer: asked },
          { format: 'svg', kerf: 0, baseName: 'x', source },
        ),
      ).toEqual({ ok: false, messages: [UNREVIEWED_EXPORT] });
      for (const format of ['pdf', 'dxf', 'svg'] as const) {
        expect(drawingFile(format, [], { drawing: 'D', sheets: [] }, source)).toEqual({
          ok: false,
          message: UNREVIEWED_EXPORT,
        });
      }
      for (const format of ['stl', 'stl-each', '3mf', 'step'] as const) {
        expect(await exportBodyFiles(refusing, format, { source })).toEqual({
          ok: false,
          message: UNREVIEWED_EXPORT,
        });
      }
    }
  });

  it('writes from an approved agent branch as from main', async () => {
    const doc = cabinet();
    const { result } = await regen(doc);
    const sources = { document: doc, parts: result.parts, assemblies: result.assemblies };
    const approved = await exportCutList('list', sources, { source: agent('approved') });
    const main = await exportCutList('list', sources, { source: MAIN });
    expect(text(approved.bytes)).toBe(text(main.bytes));
  });
});
