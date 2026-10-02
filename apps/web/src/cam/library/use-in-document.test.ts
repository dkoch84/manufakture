import {
  BUILTIN_LIBRARY_ID,
  BUILTIN_TOOLS,
  DEFAULT_MACHINE_ID,
  MACHINES,
  MATERIAL_FEED_CATEGORY,
  findBuiltinTool,
  findMachine,
  findPresetFor,
  resolvePreset,
} from '@manufakture/cam/library';
import {
  CAM_TABLE_ID_PATTERN,
  CamToolSchema,
  MATERIALS,
  applyCommand,
  createDocument,
  validateDocument,
  type ManufaktureDocument,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { USER_LIBRARY_ID } from './store';
import { useToolInDocument } from './use-in-document';

function apply(doc: ManufaktureDocument, command: Parameters<typeof applyCommand>[1]) {
  const r = applyCommand(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
}

describe('presets for core materials', () => {
  it('every core material id resolves to a preset on every built-in tool', () => {
    for (const material of MATERIALS) {
      expect(Object.hasOwn(MATERIAL_FEED_CATEGORY, material.id), material.id).toBe(true);
      for (const tool of BUILTIN_TOOLS) {
        const r = resolvePreset(tool, material.id);
        expect(r.ok, `${tool.id} / ${material.id}`).toBe(true);
        if (r.ok) {
          expect(r.value.feed).toBeGreaterThan(0);
          expect(r.value.rpm).toBeGreaterThan(0);
          expect(r.value.stepdown).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every feed category and machine id is a valid CAM table id', () => {
    for (const category of Object.values(MATERIAL_FEED_CATEGORY)) {
      expect(CAM_TABLE_ID_PATTERN.test(category)).toBe(true);
    }
    for (const m of MACHINES) {
      expect(CAM_TABLE_ID_PATTERN.test(m.id)).toBe(true);
      for (const post of m.posts) expect(CAM_TABLE_ID_PATTERN.test(post)).toBe(true);
    }
    expect(findMachine(DEFAULT_MACHINE_ID)).toBeDefined();
  });
});

describe('use in document', () => {
  it('every built-in tool copies into a valid addCamTool command', () => {
    let doc = createDocument({ id: 'doc-1', name: 'Sign' });
    BUILTIN_TOOLS.forEach((tool, i) => {
      const command = useToolInDocument(doc, tool, BUILTIN_LIBRARY_ID);
      expect(command.tool.id).toBe(`tool#${i + 1}`);
      expect(CamToolSchema.safeParse(command.tool).success, tool.id).toBe(true);
      doc = apply(doc, command);
      expect(doc.cam.tools.at(-1)).toEqual(command.tool);
      expect(doc.cam.tools.at(-1)!.source).toEqual({ library: 'builtin', id: tool.id });
    });
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.cam.tools.map((t) => t.number)).toContain(201);
  });

  it('a copied tool keeps its presets, found by core material id', () => {
    const doc = createDocument({ id: 'doc-1', name: 'Sign' });
    const after = apply(
      doc,
      useToolInDocument(doc, findBuiltinTool('c3d-201')!, BUILTIN_LIBRARY_ID),
    );
    const tool = after.cam.tools[0]!;
    const preset = findPresetFor(tool.presets, 'plywood');
    expect(preset?.feed).toEqual({ source: '100in/min', lengthUnit: 'in', angleUnit: 'deg' });
    expect(findPresetFor(tool.presets, 'oak')?.material).toBe('hardwood');
  });

  it('takes the next id after deleted tools, and names the user library', () => {
    let doc = createDocument({ id: 'doc-1', name: 'Sign' });
    const t = findBuiltinTool('c3d-102')!;
    doc = apply(doc, useToolInDocument(doc, t, BUILTIN_LIBRARY_ID));
    doc = apply(doc, { type: 'deleteCamTool', toolId: 'tool#1' });
    const command = useToolInDocument(doc, t, USER_LIBRARY_ID);
    expect(command.tool.id).toBe('tool#2');
    expect(command.tool.source).toEqual({ library: 'user', id: 'c3d-102' });
    expect(applyCommand(doc, command).ok).toBe(true);
  });
});
