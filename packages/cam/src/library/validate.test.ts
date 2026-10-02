import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOLS,
  LIBRARY_LIMITS,
  findBuiltinTool,
  parseToolLibrary,
  serializeToolLibrary,
  validateLibraryTool,
  validateToolLibraryFile,
} from './index';

const base = () =>
  JSON.parse(JSON.stringify(findBuiltinTool('c3d-201'))) as Record<string, unknown>;

function refusal(value: unknown): string {
  const r = validateLibraryTool(value);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error.message;
}

describe('library validation (outside input)', () => {
  it('a library file round-trips through JSON', () => {
    const json = serializeToolLibrary(BUILTIN_TOOLS);
    const r = parseToolLibrary(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tools).toEqual(BUILTIN_TOOLS);
  });

  it('refuses unknown and missing fields, at every level', () => {
    expect(refusal({ ...base(), colour: 'red' })).toBe('tool.colour: unknown field');
    const noDiameter = base();
    delete noDiameter.diameter;
    expect(refusal(noDiameter)).toBe('tool.diameter: missing');
    const t = base();
    (t.presets as Record<string, unknown>[])[0]!.extra = 1;
    expect(refusal(t)).toBe('tool.presets[0].extra: unknown field');
    const v = base();
    (v.presets as { verified: Record<string, unknown> }[])[1]!.verified.all = true;
    expect(refusal(v)).toBe('tool.presets[1].verified.all: unknown field');
  });

  it('refuses wrong types and out-of-range numbers', () => {
    expect(refusal({ ...base(), diameter: '0.25' })).toContain('tool.diameter');
    expect(refusal({ ...base(), diameter: 0 })).toContain('at least 0.001');
    expect(refusal({ ...base(), diameter: 100 })).toContain('at most'); // 100 in is too long
    expect(refusal({ ...base(), flutes: 2.5 })).toContain('whole');
    expect(refusal({ ...base(), flutes: 0 })).toContain('tool.flutes');
    expect(refusal({ ...base(), kind: 'laser' })).toContain('tool.kind');
    expect(refusal({ ...base(), unit: 'cm' })).toContain('tool.unit');
    expect(refusal({ ...base(), verified: 'yes' })).toContain('tool.verified');
    expect(refusal({ ...base(), id: 'Has Spaces' })).toContain('tool.id');
    expect(refusal({ ...base(), name: ' padded' })).toContain('tool.name');
    expect(refusal({ ...base(), name: 'x'.repeat(LIBRARY_LIMITS.name + 1) })).toContain('longer');
    expect(
      refusal({ ...base(), vendor: { maker: 'X', number: -1, url: 'https://x.y' } }),
    ).toContain('tool.vendor.number');
    expect(
      refusal({ ...base(), vendor: { maker: 'X', number: 1, url: 'javascript:alert(1)' } }),
    ).toContain('tool.vendor.url');
    const p = base();
    (p.presets as Record<string, unknown>[])[0]!.stepover = 1.5;
    expect(refusal(p)).toContain('tool.presets[0].stepover');
    const n = base();
    (n.presets as Record<string, unknown>[])[0]!.rpm = Number.NaN;
    expect(refusal(n)).toContain('tool.presets[0].rpm');
  });

  it('refuses broken kind rules, as the document schema does', () => {
    expect(refusal({ ...base(), kind: 'bull' })).toContain('corner radius');
    expect(refusal({ ...base(), cornerRadius: 0.05 })).toContain('no corner radius');
    expect(refusal({ ...base(), kind: 'vbit' })).toContain('included angle');
    expect(refusal({ ...base(), angleDeg: 30 })).toContain('no angle');
    expect(refusal({ ...base(), tipDiameter: 0.01 })).toContain('no tip diameter');
    expect(refusal({ ...base(), kind: 'bull', cornerRadius: 0.2 })).toContain('half the diameter');
    expect(refusal({ ...base(), kind: 'vbit', angleDeg: 90, tipDiameter: 0.25 })).toContain(
      'less than the diameter',
    );
    expect(validateLibraryTool({ ...base(), kind: 'bull', cornerRadius: 0.03 }).ok).toBe(true);
    expect(validateLibraryTool({ ...base(), kind: 'drill', angleDeg: 118 }).ok).toBe(true);
  });

  it('refuses two presets for one category and two tools with one id', () => {
    const t = base();
    const presets = t.presets as unknown[];
    presets.push(presets[0]);
    expect(refusal(t)).toContain('two presets for "plywood"');
    const file = JSON.parse(serializeToolLibrary(BUILTIN_TOOLS)) as { tools: unknown[] };
    file.tools.push(file.tools[0]);
    const r = validateToolLibraryFile(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('two tools with id "c3d-201"');
  });

  it('refuses a wrong format, version, non-JSON, non-plain objects and oversized lists', () => {
    const json = JSON.parse(serializeToolLibrary([])) as Record<string, unknown>;
    expect(validateToolLibraryFile({ ...json, format: 'other' }).ok).toBe(false);
    expect(validateToolLibraryFile({ ...json, version: 2 }).ok).toBe(false);
    expect(parseToolLibrary('{').ok).toBe(false);
    expect(parseToolLibrary('[]').ok).toBe(false);
    expect(validateLibraryTool(new Date()).ok).toBe(false);
    expect(validateLibraryTool(null).ok).toBe(false);
    const polluted = parseToolLibrary(
      '{"format":"manufakture-tool-library","version":1,"tools":[],"__proto__":{"x":1}}',
    );
    expect(polluted.ok).toBe(false);
    const many = { ...json, tools: Array.from({ length: LIBRARY_LIMITS.tools + 1 }, () => ({})) };
    const r = validateToolLibraryFile(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('more than');
  });

  it('cuts a long unknown key to 64 characters in the error', () => {
    const key = 'k'.repeat(10_000);
    const message = refusal({ ...base(), [key]: 1 });
    expect(message).toBe(`tool.${'k'.repeat(64)}...: unknown field`);
  });

  it('refuses values below the minimums, so every allowed value formats as plain decimals', () => {
    const preset = (patch: Record<string, unknown>) => {
      const t = base();
      Object.assign((t.presets as Record<string, unknown>[])[0]!, patch);
      return t;
    };
    expect(refusal({ ...base(), diameter: 0.0009 })).toContain('tool.diameter');
    expect(refusal({ ...base(), fluteLength: 1e-7 })).toContain('tool.fluteLength');
    expect(refusal(preset({ rpm: 0.5 }))).toContain('tool.presets[0].rpm');
    expect(refusal(preset({ feed: 0.9 }))).toContain('tool.presets[0].feed');
    expect(refusal(preset({ plunge: 1e-9 }))).toContain('tool.presets[0].plunge');
    expect(refusal(preset({ stepdown: 0.0001 }))).toContain('tool.presets[0].stepdown');
    expect(refusal(preset({ stepover: 0.0005 }))).toContain('tool.presets[0].stepover');
    expect(refusal({ ...base(), kind: 'vbit', angleDeg: 90, tipDiameter: 0.0001 })).toContain(
      'tool.tipDiameter',
    );
    expect(validateLibraryTool({ ...base(), kind: 'vbit', angleDeg: 90, tipDiameter: 0 }).ok).toBe(
      true,
    );
    const smallest = preset({ rpm: 1, feed: 1, plunge: 1, stepdown: 0.001, stepover: 0.001 });
    const r = validateLibraryTool({ ...smallest, diameter: 0.001, fluteLength: 0.001 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const v of [
        r.value.diameter,
        r.value.presets[0]!.stepdown,
        r.value.presets[0]!.stepover,
      ]) {
        expect(String(v)).not.toMatch(/e/i);
      }
    }
  });

  it('refuses preset categories that are not feed categories, and maps core material ids', () => {
    const withCategory = (category: string) => {
      const t = base();
      (t.presets as Record<string, unknown>[]).splice(1);
      (t.presets as Record<string, unknown>[])[0]!.category = category;
      return t;
    };
    expect(refusal(withCategory('granite'))).toBe(
      'tool.presets[0].category: "granite" is not a feed category',
    );
    const r = validateLibraryTool(withCategory('oak'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.presets[0]!.category).toBe('hardwood');
    // A material id and its category in one tool are two presets for one category.
    const t = base();
    (t.presets as Record<string, unknown>[])[0]!.category = 'birch';
    expect(refusal(t)).toContain('tool.presets[0].category');
    const dup = base();
    (dup.presets as Record<string, unknown>[])[0]!.category = 'mdf';
    expect(refusal(dup)).toContain('two presets for "mdf"');
  });

  it('returns a copy holding only known fields', () => {
    const input = base();
    const r = validateLibraryTool(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBe(input);
      expect(r.value.presets).not.toBe(input.presets);
    }
  });
});
