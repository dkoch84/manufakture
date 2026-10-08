// The takeoff panel's settings form (M6 plan T6.3b): precuts, waste, currency and the lengths the
// yard sells, stored in `domains.construction.takeoff` as one command. The takeoff and its files
// are tested in `@manufakture/domain-construction`.

import { applyCommand } from '@manufakture/core';
import { shedDocument } from '@manufakture/domain-construction/fixtures/shed-model';
import { describe, expect, it } from 'vitest';
import { documentConstruction } from '../settings';
import { readTakeoffForm, takeoffForm, takeoffSettingsCommand } from './settings';

const FT_IN = shedDocument().units;

describe('the takeoff settings form', () => {
  it('stores precuts, waste, currency and lengths in domains.construction as one command', () => {
    const doc = shedDocument();
    const form = { ...takeoffForm(undefined, ['us-2x4']), precuts: false, waste: '10' };
    form.currency = 'usd';
    form.lengths = { 'us-2x4': `8', 12'`, 'us-2x6': 'cut' };
    const r = takeoffSettingsCommand(doc, form);
    if (!r.ok || r.command === null) throw new Error('no command');
    const next = applyCommand(doc, r.command);
    if (!next.ok) throw new Error(next.error.message);
    const data = documentConstruction(next.value.document);
    if (!data.ok || !data.data) throw new Error('no data');
    expect(data.data.stored.takeoff).toEqual({
      precuts: false,
      wastePercent: 10,
      currency: 'USD',
      lengths: {
        'us-2x4': [
          { source: `8'`, lengthUnit: 'in', angleUnit: 'deg' },
          { source: `12'`, lengthUnit: 'in', angleUnit: 'deg' },
        ],
        'us-2x6': [],
      },
    });
    // The rest of the settings are kept.
    expect(data.data.stored.wallTypes).toHaveLength(1);
    // And the form reads them back.
    expect(takeoffForm(data.data.stored.takeoff, ['us-2x4'])).toEqual({
      precuts: false,
      waste: '10',
      currency: 'USD',
      lengths: { 'us-2x4': `8', 12'`, 'us-2x6': 'cut' },
    });
    // Defaults again remove the takeoff settings.
    const back = takeoffSettingsCommand(next.value.document, takeoffForm(undefined, []));
    if (!back.ok || back.command === null) throw new Error('no command');
    const reset = applyCommand(next.value.document, back.command);
    if (!reset.ok) throw new Error(reset.error.message);
    const after = documentConstruction(reset.value.document);
    expect(after.ok && after.data?.stored.takeoff).toBeUndefined();
  });

  it('refuses bad fields with a message each, and bounds the text', () => {
    const form = takeoffForm(undefined, ['us-2x4']);
    const bad = readTakeoffForm(
      {
        ...form,
        waste: '120',
        currency: 'dollars',
        lengths: { 'us-2x4': `8', 2"`, 'us-2x6': 'x'.repeat(500) },
      },
      FT_IN,
    );
    expect(bad).toMatchObject({
      ok: false,
      errors: {
        waste: 'A percentage from 0 to 100.',
        currency: 'A three-letter code such as USD.',
        lengths: {
          'us-2x4': expect.stringMatching(/^2": Must be at least/),
          'us-2x6': expect.stringMatching(/^Up to 20 lengths/),
        },
      },
    });
    const many = Array.from({ length: 21 }, () => `8'`).join(',');
    expect(readTakeoffForm({ ...form, lengths: { 'us-2x4': many } }, FT_IN)).toMatchObject({
      ok: false,
    });
  });
});
