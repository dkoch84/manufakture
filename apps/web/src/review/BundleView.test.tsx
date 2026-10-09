// A bundle's assembly view: the assembly and the pose asked for, each side's mate coordinates as
// drawn and the pose's warnings, shown as text; every list in full (a page at a time) with what the
// bundle left out counted, ids with their hidden characters shown; a side that could not be posed
// shows nothing.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReviewBundle } from '@manufakture/review/data';
import { BundleView } from './BundleView';

const RLO = '‮';
const warnings = Array.from(
  { length: 12 },
  (_, i) => `Drawn with mate#${i + 1} at 600.00 mm, past its maximum of 457.20 mm.`,
);
const held = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`mate#${i + 1}`, 600]));

const bundle = {
  renders: [
    { name: 'isometric', camera: 'isometric', base: null, head: null },
    {
      name: 'Drawer open',
      camera: 'right',
      base: null,
      head: null,
      baseError: 'There is no assembly assembly#1.',
      assembly: {
        assemblyId: `assembly#1${RLO}`,
        mates: held,
        poses: { 'inst#3': { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
        base: null,
        head: {
          mates: {
            items: [
              {
                mateId: 'mate#1',
                kind: 'slider',
                coordinates: [{ name: 'distance', value: 600, unit: 'mm' }],
              },
            ],
            omitted: 4,
          },
          warnings: { items: warnings, omitted: 3 },
          skipped: { items: ['inst#4'], omitted: 0 },
        },
      },
    },
  ],
} as unknown as ReviewBundle;

describe('BundleView', () => {
  it('shows an assembly view with the pose asked for and what it did, nothing cut silently', () => {
    render(
      <BundleView
        bundle={bundle}
        scripts={[]}
        commands={{ kind: 'waiting' }}
        read={async () => null}
      />,
    );
    // The fixed view has no assembly caption.
    expect(screen.queryByTestId('review-render-assembly-0')).toBeNull();
    const caption = screen.getByTestId('review-render-assembly-1');
    // The id's right-to-left override is shown as an escape, never applied.
    expect(caption.textContent).toContain('Assembly assembly#1\\u{202e}');
    expect(caption.textContent).not.toContain(RLO);
    // All ten mates held, and the instance placed by hand.
    const asked = screen.getByTestId('review-assembly-1-held');
    expect(asked.querySelectorAll('li')).toHaveLength(10);
    expect(asked.textContent).toContain('mate#10 at 600');
    expect(screen.getByTestId('review-assembly-1-placed').textContent).toContain(
      'inst#3 placed by hand',
    );
    expect(screen.queryByTestId('review-assembly-base')).toBeNull();
    const head = screen.getByTestId('review-assembly-head');
    expect(screen.getByTestId('review-assembly-1-head-mates').textContent).toContain(
      'mate#1 distance 600 mm',
    );
    expect(screen.getByTestId('review-assembly-1-head-skipped').textContent).toContain('inst#4');
    // Twelve warnings, every one listed, and the three the bundle left out counted; the four
    // mates it left out too.
    const listed = screen.getByTestId('review-assembly-1-head-warnings');
    expect(listed.querySelectorAll('li')).toHaveLength(12);
    expect(listed.textContent).toContain('mate#12 at 600.00 mm');
    expect(head.textContent).toContain('and 3 more left out of the bundle');
    expect(head.textContent).toContain('and 4 more left out of the bundle');
  });
});
