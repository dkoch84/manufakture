import { describe, expect, it } from 'vitest';
import { CANNED_CYCLE_G_CODES, compileDialect } from './dialect';
import type { Dialect } from './dialect';
import { DRILLING, DRILLING_CYCLES, PROFILE, TWO_TOOLS, job } from './golden-jobs';
import { BUILTIN_DIALECTS, BUILTIN_POST_IDS, builtinDialect } from './posts';
import { testDialect } from './test-helpers';
import { postProcess } from './writer';

// The dialect fields and post options T5.4c added to the engine: canned cycles, tool length
// offsets (G43 H), path blending (G64 P) and a controller's own arc radius rule.

const CYCLE_CODES = [...CANNED_CYCLE_G_CODES];

/** A LinuxCNC-like test dialect: M6, G43, G64 and canned cycles. */
function full(over: Partial<Dialect> = {}): Dialect {
  const base = testDialect();
  return testDialect({
    gCodes: [...base.gCodes, 'G43', 'G64', ...CYCLE_CODES],
    mCodes: [...base.mCodes, 'M6'],
    toolChange: 'm6',
    splitPerTool: false,
    cannedCycles: true,
    ...over,
  });
}

function message(r: { ok: boolean; error?: { message: string } }): string {
  return r.ok ? '' : r.error!.message;
}

describe('dialect fields', () => {
  it('accepts the new fields, all optional', () => {
    expect(compileDialect(testDialect()).ok).toBe(true);
    expect(
      compileDialect(
        full({
          toolLengthOffset: true,
          pathBlending: true,
          arcRadiusTolerance: { mm: 0.002, inch: 0.0002 },
        }),
      ).ok,
    ).toBe(true);
  });

  it('refuses each field without the codes it writes', () => {
    const base = full();
    const without = (code: string): string[] => base.gCodes.filter((g) => g !== code);
    expect(
      message(compileDialect(full({ toolLengthOffset: true, gCodes: without('G43') }))),
    ).toMatch(/G43/);
    expect(message(compileDialect(full({ toolLengthOffset: true, toolChange: 'none' })))).toMatch(
      /m6/,
    );
    expect(message(compileDialect(full({ pathBlending: true, gCodes: without('G64') })))).toMatch(
      /G64/,
    );
    for (const code of CYCLE_CODES) {
      expect(message(compileDialect(full({ gCodes: without(code) }))), code).toMatch(code);
    }
  });

  it('refuses malformed values', () => {
    const bad: unknown[] = [
      { toolLengthOffset: 'yes' },
      { pathBlending: 1 },
      { arcRadiusTolerance: 0.002 },
      { arcRadiusTolerance: { mm: 0.002 } },
      { arcRadiusTolerance: { mm: 0, inch: 0.0002 } },
      { arcRadiusTolerance: { mm: 0.002, inch: 0.0002, cm: 1 } },
      { arcRadiusTolerance: { mm: 1, inch: 0.0002 } },
    ];
    for (const over of bad) {
      expect(compileDialect({ ...full(), ...(over as object) }).ok, JSON.stringify(over)).toBe(
        false,
      );
    }
  });
});

describe('post options', () => {
  const j = job(DRILLING_CYCLES);

  it('refuses canned cycles where the dialect has none, and G43 without M6', () => {
    const r = postProcess(j, testDialect(), { cannedCycles: true });
    expect(message(r)).toMatch(/no canned cycles/);
    const t = postProcess(job(PROFILE), full({ toolChange: 'none' }), { toolLengthOffset: true });
    expect(message(t)).toMatch(/G43/);
  });

  it('writes cycles only when asked, and a cycle with a dwell as moves', () => {
    const asked = postProcess(j, full(), { cannedCycles: true });
    const plain = postProcess(j, full());
    expect(asked.ok && plain.ok).toBe(true);
    if (!asked.ok || !plain.ok) return;
    expect(asked.value.files[0]!.lines.filter((l) => l.includes('G81'))).toHaveLength(3);
    expect(asked.value.files[0]!.lines.filter((l) => l.includes('G83'))).toHaveLength(3);
    expect(plain.value.files[0]!.text).not.toMatch(/G8\d/);
    const dwell = postProcess(job(DRILLING), full(), { cannedCycles: true });
    expect(dwell.ok && dwell.value.files[0]!.text).not.toMatch(/G8\d/);
  });

  it('writes cycle words in inches under G20', () => {
    const r = postProcess(j, full(), { cannedCycles: true, units: 'inch' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.files[0]!.lines).toContain('G99 G83 X0.3937 Y0.3937 Z-0.315 R0.0394 Q0.1181');
    }
  });

  it('writes G64 P as the tolerance rounded down, and refuses a tolerance it cannot write', () => {
    const blend = full({ pathBlending: true });
    const r = postProcess(job(PROFILE), blend, { tolerance: 0.0123456789 });
    expect(r.ok && r.value.files[0]!.lines).toContain('G64 P0.012345');
    const tiny = postProcess(job(PROFILE), blend, { tolerance: 1e-7 });
    expect(message(tiny)).toMatch(/G64 P/);
  });

  it('writes G43 H after each M6 when the dialect or the call asks', () => {
    // The V-bit is #302, over the default T limit of 255.
    const on = postProcess(job(TWO_TOOLS), full({ toolLengthOffset: true, maxToolNumber: 999 }));
    expect(on.ok && on.value.files[0]!.lines.filter((l) => l.startsWith('G43'))).toEqual([
      'G43 H201',
      'G43 H302',
    ]);
    const off = postProcess(job(TWO_TOOLS), full({ toolLengthOffset: true, maxToolNumber: 999 }), {
      toolLengthOffset: false,
    });
    expect(off.ok && off.value.files[0]!.text).not.toMatch(/G43/);
  });
});

describe('built-in posts', () => {
  it('lists every built-in dialect by its id', () => {
    expect([...BUILTIN_POST_IDS].sort()).toEqual([
      'carbide-motion',
      'grbl',
      'grblhal',
      'linuxcnc',
      'mach3',
    ]);
    for (const [id, d] of Object.entries(BUILTIN_DIALECTS)) {
      expect(d.dialect.id).toBe(id);
      expect(builtinDialect(id)).toBe(d);
    }
    expect(builtinDialect('toString')).toBeUndefined();
    expect(builtinDialect('fanuc')).toBeUndefined();
  });
});
