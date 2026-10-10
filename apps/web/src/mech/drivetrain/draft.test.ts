import { createDocument, type Drivetrain, type StoredExpression } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  drivetrainDraft,
  drivetrainFromDraft,
  newDrivetrainDraft,
  nextMechId,
  withKind,
  withStage,
} from './draft';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'in', angleUnit: 'deg' });
const units = createDocument({ id: 'd', name: 'D' }).units;

const stored = (): Drivetrain => ({
  id: 'drive#1',
  name: 'Main',
  assembly: 'assembly#1',
  stages: [
    { id: 'stage#1', kind: 'motor', use: 'pp#1', instance: 'inst#2', mate: 'mate#1' },
    {
      id: 'stage#2',
      kind: 'belt',
      ratio: { driver: x('20'), driven: x('60') },
      efficiency: x('0.95'),
      belt: 'pp#4',
      pulleys: ['pp#5', 'pp#6'],
    },
    { id: 'stage#3', kind: 'shaft', instance: 'inst#3', bearings: [{ use: 'pp#2' }] },
    { id: 'stage#4', kind: 'gear', ratio: x('3'), efficiency: x('0.97'), instances: ['inst#4'] },
    {
      id: 'stage#5',
      kind: 'planetary',
      ratio: x('5'),
      efficiency: x('0.9'),
      instances: ['inst#5', 'inst#6', 'inst#7', 'inst#8'],
    },
  ],
  output: {
    kind: 'spool',
    instance: 'inst#1',
    cable: 'pp#3',
    length: x('100'),
    fairlead: { bendDiameter: x('1') },
  },
});

describe('drivetrain drafts', () => {
  it('round-trip a stored drivetrain, keeping the fields the editor does not show', () => {
    const d = stored();
    const built = drivetrainFromDraft(drivetrainDraft(d), units);
    expect(built).toEqual({ ok: true, value: d });
  });

  it('keep a planetary’s members past the first two, and want an output member with them', () => {
    const draft = drivetrainDraft(stored());
    draft.stages[4] = { ...draft.stages[4]!, outputMember: 'inst#9' };
    const built = drivetrainFromDraft(draft, units);
    if (!built.ok) throw new Error(built.message);
    expect(built.value.stages[4]).toMatchObject({
      instances: ['inst#5', 'inst#9', 'inst#7', 'inst#8'],
    });
    draft.stages[4] = { ...draft.stages[4]!, outputMember: '' };
    expect(drivetrainFromDraft(draft, units)).toEqual({
      ok: false,
      message: 'stage 5 (stage#5): choose an output member; the stage also has inst#7, inst#8',
    });
  });

  it('keep an untouched expression with its units and re-read an edited one', () => {
    const draft = drivetrainDraft(stored());
    draft.output = { ...draft.output, length: '2.5 m' };
    draft.stages[3] = { ...draft.stages[3]!, inertia: '1e-5 kg*m^2' };
    const built = drivetrainFromDraft(draft, units);
    if (!built.ok) throw new Error(built.message);
    const out = built.value.output as Extract<Drivetrain['output'], { kind: 'spool' }>;
    expect(out.length).toEqual({ source: '2.5 m', lengthUnit: 'mm', angleUnit: 'deg' });
    expect(out.fairlead).toEqual({ bendDiameter: x('1') });
    expect(built.value.stages[1]).toMatchObject({ ratio: { driver: x('20') } });
    expect(built.value.stages[3]).toMatchObject({ inertia: { source: '1e-5 kg*m^2' } });
  });

  it('change a stage’s kind keeping what both kinds share', () => {
    const draft = drivetrainDraft(stored());
    const gear = withKind(draft.stages[1]!, 'planetary');
    expect(gear).toMatchObject({
      kind: 'planetary',
      ratioBy: 'teeth',
      driver: '20',
      efficiency: '0.95',
    });
    const shaft = withKind(draft.stages[3]!, 'shaft');
    expect(shaft).toMatchObject({ kind: 'shaft', ratio: '', efficiency: '' });
    // A belt's catalog uses are dropped with its kind, and not brought back with it.
    const back = withKind(withKind(draft.stages[1]!, 'gear'), 'belt');
    draft.stages[1] = back;
    const built = drivetrainFromDraft(draft, units);
    if (!built.ok) throw new Error(built.message);
    expect(built.value.stages[1]).toMatchObject({ kind: 'belt', efficiency: { source: '0.95' } });
    expect(built.value.stages[1]).not.toHaveProperty('belt');
  });

  it('give fresh ids from the counters and past the unsaved ones', () => {
    const nextIds = { drive: 2, stage: 5 };
    const d = newDrivetrainDraft(nextIds);
    expect(d.id).toBe('drive#2');
    expect(d.stages.map((s) => s.id)).toEqual(['stage#5']);
    const more = withStage(withStage(d, 'belt', nextIds), 'shaft', nextIds);
    expect(more.stages.map((s) => s.id)).toEqual(['stage#5', 'stage#6', 'stage#7']);
    expect(nextMechId(nextIds, 'stage', ['stage#1', 'stage#9'])).toBe('stage#10');
  });

  it('say what is missing', () => {
    const d = newDrivetrainDraft({});
    expect(drivetrainFromDraft(d, units)).toEqual({
      ok: false,
      message: "stage 1 (stage#1): choose the motor's purchased part",
    });
    const belt = withStage({ ...d, stages: [{ ...d.stages[0]!, use: 'pp#1' }] }, 'belt', {});
    expect(drivetrainFromDraft(belt, units)).toEqual({
      ok: false,
      message: 'stage 2 (stage#2): type its ratio',
    });
  });
});
