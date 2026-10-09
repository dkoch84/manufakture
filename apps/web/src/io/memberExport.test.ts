import { meshProperties, parseStl, validate3mf } from '@manufakture/io';
import { describe, expect, it, vi } from 'vitest';
import { shedFixture } from '../viewport/memberFixtures';
import { createMemberStore } from '../viewport/memberStore';
import { boxBody } from '../viewport/testMeshes';
import { exportBodies } from './actions';
import type { Exchanger } from './exchange';
import { matrix3x4, memberExportBodies, shownMemberExports } from './memberExport';

function fakeExchanger(): Exchanger {
  const bodies = [{ id: 'body1', name: 'Sheathing' }];
  return {
    bodies: () => bodies,
    tessellate: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'Sheathing', mesh: boxBody({ min: [0, -20, 0], size: [100, 11, 50] }).mesh }],
    })),
    exportStep: vi.fn(async () => ({ ok: true as const, value: new Uint8Array([1]) })),
    importStep: vi.fn(),
    retain: vi.fn(() => []),
    reimport: vi.fn(async () => []),
  } as unknown as Exchanger;
}

describe('member export', () => {
  it('turns a column-major 4x4 into 3MF order', () => {
    const m = new Float32Array([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1]);
    expect(matrix3x4(m, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('places every member, named by full id, closed and with its blank volume', () => {
    const shed = shedFixture();
    const bodies = memberExportBodies(shed.view);
    const members = shed.view.sets.flatMap((s) => s.members);
    expect(bodies).toHaveLength(members.length);
    expect(new Set(bodies.map((b) => b.name))).toEqual(
      new Set(members.map((m) => `${m.owner}:${m.id}`)),
    );
    const king = bodies.find((b) => b.name === 'door-1:king-l')!;
    const member = members.find((m) => m.owner === 'door-1' && m.id === 'king-l')!;
    const p = king.mesh.positions;
    // Placed: its lowest point sits on the bottom plate.
    let zMin = Infinity;
    for (let i = 2; i < p.length; i += 3) zMin = Math.min(zMin, p[i]!);
    expect(zMin).toBeCloseTo(38.1, 3);
    // An empty view exports nothing; the default reads the store's shown part.
    expect(memberExportBodies({ meshes: new Map(), sets: [] })).toEqual([]);
    const store = createMemberStore();
    expect(shownMemberExports(store)).toEqual([]);
    store.getState().load(shed.partId, shed.view);
    expect(shownMemberExports(store)).toHaveLength(members.length);
    expect(member.length).toBeGreaterThan(2000);
  });

  it('3MF: one object per member after the bodies; STL: members in the soup', async () => {
    const shed = shedFixture();
    const members = memberExportBodies(shed.view);
    const ex = fakeExchanger();

    const threemf = await exportBodies(ex, '3mf', { members });
    if (!threemf.ok) throw new Error(threemf.message);
    const report = validate3mf(threemf.value[0]!.bytes);
    expect(report.problems).toEqual([]);
    const names = report.parsed!.objects.map((o) => o.name);
    expect(names).toHaveLength(1 + members.length);
    expect(names[0]).toBe('Sheathing');
    expect(names).toContain('wall-s:s1');
    expect(names).toContain('door-1:header:2');

    const stl = await exportBodies(ex, 'stl', { members });
    if (!stl.ok) throw new Error(stl.message);
    // Members touch (studs stand on plates), so the welded soup is not one manifold, but each
    // member was checked closed on the way out, and the volumes add up.
    const mesh = parseStl(stl.value[0]!.bytes).mesh;
    expect(mesh.indices.length / 3).toBe(12 * (members.length + 1));
    const blanks = shed.view.sets
      .flatMap((s) => s.members)
      .reduce((v, m) => v + m.length * m.stock.width * m.stock.depth, 0);
    expect(meshProperties(mesh).volume).toBeCloseTo(blanks + 100 * 11 * 50, -3);

    const each = await exportBodies(ex, 'stl-each', { members, fileBase: 'Shed' });
    if (!each.ok) throw new Error(each.message);
    expect(each.value.map((f) => f.name)).toEqual(['Sheathing.stl', 'Shed members.stl']);

    const step = await exportBodies(ex, 'step', { members });
    if (!step.ok) throw new Error(step.message);
    expect(step.message).toMatch(/Framing members are not exported to STEP here\.$/);

    // Members alone still export as meshes.
    const only = await exportBodies(ex, '3mf', { bodies: [], members, fileBase: 'Shed' });
    if (!only.ok) throw new Error(only.message);
    expect(validate3mf(only.value[0]!.bytes).parsed!.objects).toHaveLength(members.length);
    expect((await exportBodies(ex, 'step', { bodies: [], members })).ok).toBe(false);
  });

  it('STEP: members as B-reps built on demand, in one file with the bodies, under a disclaimer', async () => {
    const shed = shedFixture();
    const members = memberExportBodies(shed.view);
    const ex = fakeExchanger();
    const header = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');",
      "FILE_NAME('x','t',(''),(''),'p','o','u');",
      'ENDSEC;',
      'DATA;',
      "#1 = PRODUCT('Sheathing','Sheathing','',(#2));",
      'ENDSEC;',
    ].join('\n');
    const withMembers = vi.fn(async () => ({
      ok: true as const,
      value: {
        data: new TextEncoder().encode(header),
        members: members.length - 1,
        failed: ['door-1:header:2'],
      },
    }));
    ex.exportStepWithMembers = withMembers;
    const text = "Not an engineering tool: don't build from this alone.";
    const r = await exportBodies(ex, 'step', {
      members,
      partId: 'part#1',
      stepDescription: text,
      fileBase: 'Shed',
    });
    if (!r.ok) throw new Error(r.message);
    // The bodies and every member's full id go to the regen worker in one request.
    expect(withMembers).toHaveBeenCalledWith(
      ['body1'],
      undefined,
      'part#1',
      members.map((m) => m.name),
    );
    expect(ex.exportStep).not.toHaveBeenCalled();
    expect(r.message).toBe(
      `Exported Shed.step (${r.value[0]!.bytes.length} B). ${members.length - 1} framing members as B-reps. Left out, not built: door-1:header:2.`,
    );
    const out = new TextDecoder().decode(r.value[0]!.bytes);
    expect(out).toContain(
      "FILE_DESCRIPTION(('Not an engineering tool: don''t build from this alone.'),'2;1');",
    );
    expect(out).toContain("#1 = PRODUCT('Sheathing'");

    // Members alone, no bodies: still one STEP file.
    const only = await exportBodies(ex, 'step', { bodies: [], members, partId: 'part#1' });
    expect(only.ok).toBe(true);
    // No part named: the members cannot be built, and the bodies go alone.
    const plain = await exportBodies(ex, 'step', { members });
    if (!plain.ok) throw new Error(plain.message);
    expect(plain.message).toMatch(/Framing members are not exported to STEP here\.$/);
  });
});
