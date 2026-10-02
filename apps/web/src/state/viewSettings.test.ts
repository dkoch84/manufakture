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
    expect(stored.state).toEqual({
      preset: 'fusion',
      projection: 'orthographic',
      slicer: 'orcaslicer',
      slicerHelpDismissed: [],
    });

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

  it('keeps the slicer for Open in slicer, and the slicers whose help was closed', () => {
    const a = createViewSettingsStore();
    expect(a.getState().slicer).toBe('orcaslicer');
    a.getState().setSlicer('bambustudio');
    a.getState().dismissSlicerHelp('bambustudio');
    a.getState().dismissSlicerHelp('bambustudio');
    const b = createViewSettingsStore();
    expect(b.getState().slicer).toBe('bambustudio');
    expect(b.getState().slicerHelpDismissed).toEqual(['bambustudio']);
  });

  it('ignores a stored slicer it does not know', () => {
    localStorage.setItem(
      VIEW_SETTINGS_KEY,
      JSON.stringify({
        state: { slicer: 'cura', slicerHelpDismissed: ['cura', 'prusaslicer', 'prusaslicer', 7] },
        version: 1,
      }),
    );
    const s = createViewSettingsStore();
    expect(s.getState().slicer).toBe('orcaslicer');
    expect(s.getState().slicerHelpDismissed).toEqual(['prusaslicer']);
    s.getState().setSlicer('cura' as never);
    expect(s.getState().slicer).toBe('orcaslicer');
    localStorage.setItem(
      VIEW_SETTINGS_KEY,
      JSON.stringify({ state: { slicerHelpDismissed: 'x' } }),
    );
    expect(createViewSettingsStore().getState().slicerHelpDismissed).toEqual([]);
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
