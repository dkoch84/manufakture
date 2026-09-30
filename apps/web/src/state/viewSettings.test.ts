import { describe, expect, it } from 'vitest';
import { VIEW_SETTINGS_KEY, createViewSettingsStore, hiddenBodiesOf } from './viewSettings';

describe('view settings', () => {
  it('defaults to Onshape navigation and perspective', () => {
    const s = createViewSettingsStore();
    expect(s.getState().preset).toBe('onshape');
    expect(s.getState().projection).toBe('perspective');
    expect(s.getState().section.enabled).toBe(false);
  });

  it('persists the preset and projection, but not the section', () => {
    const a = createViewSettingsStore();
    a.getState().setPreset('fusion');
    a.getState().toggleProjection();
    a.getState().setSection({ enabled: true });
    const stored = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) ?? '{}');
    expect(stored.state).toEqual({ preset: 'fusion', projection: 'orthographic' });

    const b = createViewSettingsStore();
    expect(b.getState().preset).toBe('fusion');
    expect(b.getState().projection).toBe('orthographic');
    expect(b.getState().section.enabled).toBe(false);
  });

  it('ignores stored values it does not know', () => {
    localStorage.setItem(
      VIEW_SETTINGS_KEY,
      JSON.stringify({ state: { preset: 'maya', projection: 'fisheye' }, version: 1 }),
    );
    const s = createViewSettingsStore();
    expect(s.getState().preset).toBe('onshape');
    expect(s.getState().projection).toBe('perspective');
  });

  it('toggles the projection both ways', () => {
    const s = createViewSettingsStore();
    s.getState().toggleProjection();
    s.getState().toggleProjection();
    expect(s.getState().projection).toBe('perspective');
  });

  it('merges section patches and clamps the position', () => {
    const s = createViewSettingsStore();
    s.getState().setSection({ enabled: true, axis: 'x' });
    s.getState().setSection({ position: 1.7 });
    expect(s.getState().section).toEqual({
      enabled: true,
      axis: 'x',
      position: 1,
      flipped: false,
    });
    s.getState().setSection({ position: -3 });
    expect(s.getState().section.position).toBe(0);
  });

  it('keeps hidden bodies per document, out of the stored preferences', () => {
    const s = createViewSettingsStore();
    const st = () => s.getState();
    st().setBodyHidden('doc-a', 'part#1/extrude#1', true);
    st().setBodyHidden('doc-a', 'part#1/extrude#2', true);
    st().setBodyHidden('doc-b', 'part#1/extrude#1', true);
    expect(hiddenBodiesOf(st(), 'doc-a')).toEqual(['part#1/extrude#1', 'part#1/extrude#2']);
    st().setBodyHidden('doc-a', 'part#1/extrude#1', false);
    expect(hiddenBodiesOf(st(), 'doc-a')).toEqual(['part#1/extrude#2']);
    expect(hiddenBodiesOf(st(), 'doc-b')).toEqual(['part#1/extrude#1']);
    // Isolating: of these bodies, only the listed ones are hidden; others are left alone.
    st().setHiddenBodies('doc-b', ['part#1/extrude#1', 'part#1/extrude#3'], ['part#1/extrude#3']);
    expect(hiddenBodiesOf(st(), 'doc-b')).toEqual(['part#1/extrude#3']);
    st().setHiddenBodies('doc-b', ['part#1/extrude#3'], []);
    expect(st().hiddenBodies['doc-b']).toBeUndefined();
    expect(hiddenBodiesOf(st(), 'doc-c')).toEqual([]);
    const stored = JSON.parse(localStorage.getItem(VIEW_SETTINGS_KEY) ?? '{}');
    expect(stored.state?.hiddenBodies).toBeUndefined();
  });
});
