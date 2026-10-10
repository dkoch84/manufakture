import type { DomainData, MechData } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER_SHORT } from './disclaimer';
import { mechDataSummariser, mechSectionSummariser } from './review';

const se = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });
const settings = (data: unknown): DomainData => ({
  schemaVersion: 1,
  data: data as DomainData['data'],
});
const WORDS = /\b(safe|certified|compliant|pass(es|ing)?|fail(s|ing)?|ok)\b/i;

describe('mech review summaries', () => {
  it('describe the settings: a start lists both factors, an edit what changed', () => {
    expect(mechDataSummariser.summarise(undefined, settings({ factors: {} }))).toEqual([
      'Started the mechanical domain',
      'Strength factor (on yield): not set',
      'Fatigue factor: not set',
    ]);
    expect(
      mechDataSummariser.summarise(
        settings({ factors: { strength: 2 } }),
        settings({ factors: { strength: 2.5, checks: { 'shaft.': 3 } }, ambient: 300 }),
      ),
    ).toEqual([
      'Strength factor (on yield): 2 to 2.5',
      'Factor for shaft.: not set to 3',
      'ambient: 298.15 to 300',
    ]);
    expect(mechDataSummariser.summarise(settings({}), undefined)).toEqual([
      'Removed the mechanical settings',
    ]);
    expect(mechDataSummariser.summarise(undefined, settings({ bogus: 1 }))[1]).toMatch(
      /do not read/,
    );
  });

  it('describe the section by collection and id, ending with the notice', () => {
    const before: MechData = {
      loadCases: [{ id: 'lc#1', name: 'Max set' }],
      checks: [{ id: 'chk#1', check: 'bolt.preload', factor: se('2') }],
      nextIds: { lc: 2, chk: 2 },
    };
    const after: MechData = {
      loadCases: [{ id: 'lc#1', name: 'Max set', drivetrain: 'drive#1' }],
      electrical: {
        components: [{ id: 'el#1', name: 'Pack', role: 'pack' }],
        connections: [],
        harness: [],
      },
      nextIds: { lc: 2, chk: 2, el: 2 },
    };
    const lines = mechSectionSummariser.summarise(before, after);
    expect(lines).toEqual([
      'Changed load case "Max set" (lc#1): drivetrain',
      'Removed check override bolt.preload (chk#1)',
      'Added component "Pack" (el#1)',
      DISCLAIMER_SHORT,
    ]);
    for (const l of lines.slice(0, -1)) expect(l).not.toMatch(WORDS);
    expect(mechSectionSummariser.summarise(before, before)).toEqual([]);
    expect(mechSectionSummariser.summarise(undefined, undefined)).toEqual([]);
  });
});
