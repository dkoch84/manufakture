import { describe, expect, it } from 'vitest';
import { constructionDataSummariser } from './review';

const IN = (s: string) => ({ source: s, lengthUnit: 'in', angleUnit: 'deg' });

const settings = {
  levels: [{ id: 'level-1', name: 'Level 1', elevation: IN('0'), height: IN('97 1/8') }],
  floorTypes: [{ id: 'f', name: 'Floor', joistStock: 'us-2x6' }],
};

describe('construction settings for a reviewer', () => {
  it('matches named lists by id and lists framing and takeoff fields', () => {
    expect(
      constructionDataSummariser.summarise(
        { schemaVersion: 1, data: settings },
        {
          schemaVersion: 1,
          data: {
            levels: [{ id: 'level-1', name: 'Ground', elevation: IN('0'), height: IN('97 1/8') }],
            framing: { spacing: IN('24') },
            takeoff: { wastePercent: 10 },
          },
        },
      ),
    ).toEqual([
      'Changed level "Ground": name: Level 1 to Ground',
      'Removed floor type "Floor"',
      'Framing spacing: not set to 24 in',
      'Takeoff wastePercent: not set to 10',
    ]);
  });

  it('says when the document is marked as built, or no longer (#1213)', () => {
    const was = { schemaVersion: 1, data: settings };
    const now = { schemaVersion: 1, data: { ...settings, asBuilt: true } };
    expect(constructionDataSummariser.summarise(was, now)).toEqual([
      'Marked as built: features without a phase are existing',
    ]);
    expect(constructionDataSummariser.summarise(now, was)).toEqual([
      'No longer marked as built: features without a phase are new',
    ]);
  });

  it('says when the data does not read, or was removed', () => {
    expect(
      constructionDataSummariser.summarise(undefined, {
        schemaVersion: 1,
        data: { storeys: 2 },
      })[0],
    ).toMatch(/^The construction settings do not read: /);
    expect(
      constructionDataSummariser.summarise({ schemaVersion: 1, data: settings }, undefined),
    ).toEqual(['The construction settings were removed']);
  });
});
