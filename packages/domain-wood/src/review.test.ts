import { describe, expect, it } from 'vitest';
import { stockDataSummariser, woodDataSummariser } from './review';

const mm = (v: number) => ({ source: String(v), lengthUnit: 'mm', angleUnit: 'deg' });
const IN = (s: string) => ({ source: s, lengthUnit: 'in', angleUnit: 'deg' });

describe('woodworking settings for a reviewer', () => {
  it('names each setting that changed, with values as typed', () => {
    expect(
      woodDataSummariser.summarise(
        { schemaVersion: 1, data: { kerf: IN('1/8"'), grain: 'respect' } },
        {
          schemaVersion: 1,
          data: { kerf: mm(3), sheetTrims: { lengthStart: mm(10) }, maxStages: 3 },
        },
      ),
    ).toEqual([
      'Saw kerf: 1/8" to 3 mm',
      'Sheet trim, length start: not set to 10 mm',
      'Sheet layout stages: not set to 3',
      'Grain: respect to not set',
    ]);
  });

  it('says when the data was removed, does not read, or did not change', () => {
    const entry = { schemaVersion: 1, data: { grain: 'ignore' } };
    expect(woodDataSummariser.summarise(entry, undefined)).toEqual([
      'The woodworking settings were removed: every setting is the default',
    ]);
    expect(
      woodDataSummariser.summarise(entry, { schemaVersion: 1, data: { grain: 'sideways' } })[0],
    ).toMatch(/^The woodworking settings do not read: /);
    expect(woodDataSummariser.summarise(entry, entry)).toEqual([
      'The woodworking settings were rewritten without a change',
    ]);
  });
});

describe('stock overrides for a reviewer', () => {
  it('lists overrides added, changed and removed, by stock', () => {
    expect(
      stockDataSummariser.summarise(
        {
          schemaVersion: 1,
          data: {
            overrides: { 'us-ply-23-32': { thickness: mm(18.2) }, 'us-2x4': { width: mm(89) } },
          },
        },
        {
          schemaVersion: 1,
          data: {
            overrides: {
              'us-ply-23-32': { thickness: mm(18) },
              'no-such-stock': { price: { amount: 4, per: 'piece' } },
            },
          },
        },
      ),
    ).toEqual([
      'Stock override added for no-such-stock: price 4 per piece',
      expect.stringMatching(/^Stock override removed for .*\(us-2x4\): was width 89 mm$/),
      expect.stringMatching(
        /^Stock override for .*\(us-ply-23-32\): thickness 18\.2 mm to thickness 18 mm$/,
      ),
    ]);
  });
});
