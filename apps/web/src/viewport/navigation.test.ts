import { describe, expect, it } from 'vitest';
import {
  Buttons,
  DEFAULT_PRESET,
  NO_MODIFIERS,
  PRESETS,
  dragAction,
  isPresetId,
  wheelDeltaPixels,
  wheelZoomFactor,
} from './navigation';

const shift = { ...NO_MODIFIERS, shift: true };
const ctrl = { ...NO_MODIFIERS, ctrl: true };

describe('navigation presets', () => {
  it('defaults to Onshape bindings', () => {
    expect(DEFAULT_PRESET).toBe('onshape');
  });

  it('maps Onshape: right orbit, middle pan, shift or ctrl + right pan', () => {
    const p = PRESETS.onshape;
    expect(dragAction(p, Buttons.right, NO_MODIFIERS)).toBe('orbit');
    expect(dragAction(p, Buttons.middle, NO_MODIFIERS)).toBe('pan');
    expect(dragAction(p, Buttons.right, shift)).toBe('pan');
    expect(dragAction(p, Buttons.right, ctrl)).toBe('pan');
  });

  it('maps Fusion style: shift + middle orbit, middle pan', () => {
    const p = PRESETS.fusion;
    expect(dragAction(p, Buttons.middle, shift)).toBe('orbit');
    expect(dragAction(p, Buttons.middle, NO_MODIFIERS)).toBe('pan');
    expect(dragAction(p, Buttons.right, NO_MODIFIERS)).toBe('none');
  });

  it('maps FreeCAD CAD style: middle + left or right orbit, middle pan, ctrl + middle zoom', () => {
    const p = PRESETS.freecad;
    expect(dragAction(p, Buttons.middle | Buttons.left, NO_MODIFIERS)).toBe('orbit');
    expect(dragAction(p, Buttons.middle | Buttons.right, NO_MODIFIERS)).toBe('orbit');
    expect(dragAction(p, Buttons.middle, NO_MODIFIERS)).toBe('pan');
    expect(dragAction(p, Buttons.middle, ctrl)).toBe('zoom');
  });

  it('never binds the left button alone, in any preset: it selects', () => {
    for (const p of Object.values(PRESETS)) {
      for (const mods of [NO_MODIFIERS, shift, ctrl]) {
        expect(dragAction(p, Buttons.left, mods)).toBe('none');
      }
    }
  });

  it('matches the held button mask exactly', () => {
    expect(dragAction(PRESETS.onshape, Buttons.right | Buttons.left, NO_MODIFIERS)).toBe('none');
  });

  it('recognises preset ids', () => {
    expect(isPresetId('fusion')).toBe(true);
    expect(isPresetId('blender')).toBe(false);
    expect(isPresetId('toString')).toBe(false);
    expect(isPresetId(3)).toBe(false);
  });

  it('has a summary line for every preset', () => {
    for (const p of Object.values(PRESETS)) expect(p.summary.length).toBeGreaterThan(0);
  });
});

describe('wheel zoom', () => {
  it('zooms in on a forward wheel (negative deltaY) and out on a backward one', () => {
    const p = PRESETS.onshape;
    expect(wheelZoomFactor(p, -100)).toBeLessThan(1);
    expect(wheelZoomFactor(p, 100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(p, 0)).toBe(1);
  });

  it('is symmetric, so in then out returns to the start', () => {
    const p = PRESETS.onshape;
    expect(wheelZoomFactor(p, 120) * wheelZoomFactor(p, -120)).toBeCloseTo(1, 12);
  });

  it('clamps a huge delta', () => {
    const p = PRESETS.onshape;
    expect(wheelZoomFactor(p, 10_000)).toBe(wheelZoomFactor(p, 200));
  });

  it('normalises line and page delta modes to pixels', () => {
    expect(wheelDeltaPixels(3, 0)).toBe(3);
    expect(wheelDeltaPixels(3, 1)).toBe(48);
    expect(wheelDeltaPixels(1, 2, 600)).toBe(600);
  });
});
