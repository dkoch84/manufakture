// The Open in slicer help text: the platform guessed from the browser, and the steps per slicer.

import { describe, expect, it } from 'vitest';
import { SLICER_IDS } from '../state/viewSettings';
import { PLATFORMS, SLICERS, detectPlatform, handoffSteps } from './slicers';

describe('detectPlatform', () => {
  it('reads the platform from the browser', () => {
    expect(detectPlatform({ userAgentData: { platform: 'macOS' } })).toBe('macos');
    expect(detectPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('macos');
    expect(detectPlatform({ platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' })).toBe(
      'linux',
    );
    expect(detectPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' })).toBe('windows');
    expect(detectPlatform({ userAgent: 'Linux; Android 14' })).toBe('windows');
    expect(detectPlatform({})).toBe('windows');
  });
});

describe('handoffSteps', () => {
  it('has help for every slicer the settings know, on every platform', () => {
    expect(SLICERS.map((s) => s.id)).toEqual([...SLICER_IDS]);
    for (const s of SLICERS) {
      for (const p of PLATFORMS) {
        const steps = handoffSteps('Jig-Plate 1.3mf', s.id, p.id);
        expect(steps).toHaveLength(3);
        expect(steps[0]).toContain('Jig-Plate 1.3mf');
        expect(steps.join(' ')).toContain(s.name);
        // No custom-scheme launch, and no "always open" claim (unconfirmed, ADR 0012).
        expect(steps.join(' ')).not.toMatch(/always open|:\/\//i);
      }
    }
  });
});
