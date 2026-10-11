import { createDocument, type Electrical } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  electricalDraft,
  electricalFromDraft,
  parseTerminals,
  withComponent,
  withConnection,
  withSegment,
  withoutComponent,
  withoutConnection,
} from './draft';

const units = createDocument({ id: 'd', name: 'D' }).units;
const x = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

const stored = (): Electrical => ({
  assembly: 'assembly#1',
  components: [
    {
      id: 'el#1',
      name: 'Pack',
      role: 'pack',
      instance: 'inst#1',
      layout: { block: [2, -1], wiring: [0, 3] },
    },
    {
      id: 'el#2',
      name: 'Board',
      role: 'board',
      terminals: [
        { id: 'vin', name: 'Supply in', kind: 'power' },
        { id: 'gnd', name: 'GND', kind: 'ground' },
      ],
      load: { current: { source: '80 mA', lengthUnit: 'in', angleUnit: 'deg' } },
    },
  ],
  connections: [
    {
      id: 'conn#1',
      from: { component: 'el#1', terminal: '+' },
      to: { component: 'el#2', terminal: 'vin' },
      colour: 'red',
      number: '1',
    },
  ],
  harness: [
    {
      id: 'seg#1',
      from: { component: 'el#1' },
      to: { instance: 'inst#2' },
      length: { measured: true, slack: x('50') },
      connections: ['conn#1'],
    },
  ],
});

describe('the electrical draft', () => {
  it('gives back what is stored, keeping the units it was typed in and the diagram nudges', () => {
    const built = electricalFromDraft(electricalDraft(stored()), units);
    expect(built).toEqual({ ok: true, value: stored() });
  });

  it('reads typed terminals, keeping names, and refuses what is not a terminal', () => {
    expect(parseTerminals('', 'board', undefined)).toEqual({ ok: true, value: undefined });
    expect(
      parseTerminals('vin power, sda signal, gnd ground', 'board', [
        { id: 'vin', name: 'Supply in', kind: 'power' },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { id: 'vin', name: 'Supply in', kind: 'power' },
        { id: 'sda', name: 'sda', kind: 'signal' },
        { id: 'gnd', name: 'GND', kind: 'ground' },
      ],
    });
    expect(parseTerminals('vin volts', 'board', undefined)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/"volts" is not a terminal kind/) as string,
    });
    expect(parseTerminals('vin', 'board', undefined)).toMatchObject({ ok: false });
    expect(parseTerminals('a/b power', 'board', undefined)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/is not a terminal id/) as string,
    });
  });

  it('adds items with fresh ids and removes a component with its connections', () => {
    const nextIds = { el: 3, conn: 2, seg: 2 };
    let d = electricalDraft(stored());
    d = withComponent(d, 'fuse', nextIds);
    d = withConnection(d, nextIds);
    d = withSegment(d, nextIds);
    expect(d.components.map((c) => c.id)).toEqual(['el#1', 'el#2', 'el#3']);
    expect(d.components[2]!.name).toBe('Fuse');
    expect(d.connections.map((c) => c.id)).toEqual(['conn#1', 'conn#2']);
    expect(d.harness.map((s) => s.id)).toEqual(['seg#1', 'seg#2']);
    const without = withoutComponent(d, 'el#2');
    expect(without.connections.map((c) => c.id)).toEqual(['conn#2']);
    expect(without.harness[0]!.connections).toBe('');
    expect(withoutConnection(d, 'conn#1').harness[0]!.connections).toBe('');
  });

  it('names the first thing missing', () => {
    const nextIds = { el: 3, conn: 2, seg: 2 };
    const d = withConnection(electricalDraft(stored()), nextIds);
    expect(electricalFromDraft(d, units)).toEqual({
      ok: false,
      message: 'connection 2 (conn#2): choose where it starts',
    });
    const s = withSegment(electricalDraft(stored()), nextIds);
    expect(electricalFromDraft(s, units)).toEqual({
      ok: false,
      message: 'segment 2 (seg#2): choose both of its ends',
    });
  });
});
