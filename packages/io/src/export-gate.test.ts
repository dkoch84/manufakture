// The export gate (`export-gate.ts`): which branches a fabrication file may come from, failing
// closed on anything that is not a branch record, and STL, 3MF and STEP through `exportBodyFiles`
// refused before the kernel is asked for anything.

import { describe, expect, it } from 'vitest';
import { exportBodyFiles, type BodyExchanger, type BodyFileFormat } from './body-files';
import {
  ExportRefusedError,
  UNKNOWN_EXPORT_SOURCE,
  UNREVIEWED_EXPORT,
  assertExportAllowed,
  exportAllowed,
  type ExportSource,
} from './export-gate';

const agent = (review: string): ExportSource => ({
  id: 'b-1',
  provenance: { origin: 'agent', review },
});
const REFUSED_STATES = ['open', 'submitted', 'changes-requested', 'rejected'];

describe('exportAllowed', () => {
  it('allows main, a person’s branch and an approved agent branch', () => {
    expect(exportAllowed({ id: 'main' })).toEqual({ ok: true });
    expect(exportAllowed({ id: 'b-2', provenance: undefined })).toEqual({ ok: true });
    expect(exportAllowed(agent('approved'))).toEqual({ ok: true });
    expect(() => assertExportAllowed(agent('approved'))).not.toThrow();
  });

  it('refuses an agent branch in every other review state, known or not', () => {
    for (const review of [...REFUSED_STATES, 'Approved', 'approved ', '']) {
      expect(exportAllowed(agent(review))).toEqual({ ok: false, message: UNREVIEWED_EXPORT });
    }
    expect(UNREVIEWED_EXPORT).toBe(
      "This is an agent's unreviewed branch. Review it in History first.",
    );
  });

  it('fails closed on a missing source and on provenance that does not read', () => {
    for (const source of [undefined, null, 'main', 1, [], {}, { id: '' }, { id: 7 }]) {
      expect(exportAllowed(source as never)).toEqual({
        ok: false,
        message: UNKNOWN_EXPORT_SOURCE,
      });
    }
    for (const provenance of [
      null,
      'approved',
      [],
      {},
      { review: 'approved' },
      { origin: 'person', review: 'approved' },
      { origin: 'agent', review: true },
    ]) {
      expect(exportAllowed({ id: 'b-1', provenance } as never)).toEqual({
        ok: false,
        message: UNREVIEWED_EXPORT,
      });
    }
    expect(() => assertExportAllowed(agent('open'))).toThrow(ExportRefusedError);
    expect(() => assertExportAllowed(undefined)).toThrow(UNKNOWN_EXPORT_SOURCE);
  });
});

describe('exportBodyFiles behind the gate', () => {
  const box = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  };
  function exchanger() {
    const calls: string[] = [];
    const ex: BodyExchanger = {
      bodies: () => {
        calls.push('bodies');
        return [{ id: 'b', name: 'Box' }];
      },
      tessellate: async () => {
        calls.push('tessellate');
        return { ok: true, value: [{ name: 'Box', mesh: box as never }] };
      },
      exportStep: async () => {
        calls.push('exportStep');
        return { ok: true, value: new TextEncoder().encode('ISO-10303-21;') };
      },
    };
    return { ex, calls };
  }
  const formats: BodyFileFormat[] = ['stl', 'stl-each', '3mf', 'step'];

  it('refuses STL, 3MF and STEP from an agent’s unreviewed branch without touching the kernel', async () => {
    for (const format of formats) {
      for (const review of REFUSED_STATES) {
        const { ex, calls } = exchanger();
        expect(await exportBodyFiles(ex, format, { source: agent(review) })).toEqual({
          ok: false,
          message: UNREVIEWED_EXPORT,
        });
        expect(calls).toEqual([]);
      }
      const { ex, calls } = exchanger();
      expect(await exportBodyFiles(ex, format, undefined as never)).toEqual({
        ok: false,
        message: UNKNOWN_EXPORT_SOURCE,
      });
      expect(calls).toEqual([]);
    }
  });

  it('writes them from main, a person’s branch and an approved agent branch', async () => {
    for (const format of formats) {
      for (const source of [{ id: 'main' }, { id: 'b-2' }, agent('approved')]) {
        const { ex } = exchanger();
        const r = await exportBodyFiles(ex, format, { source });
        expect(r.ok).toBe(true);
      }
    }
  });
});
