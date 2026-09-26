// Mouse navigation presets. A preset maps a held button combination plus
// modifier keys to a camera action; the engine asks `dragAction` on every
// pointer down and move. The left button alone is never bound to the camera:
// it selects geometry in every preset.

export type NavAction = 'orbit' | 'pan' | 'zoom' | 'none';

/** Bit flags of `PointerEvent.buttons`. */
export const Buttons = {
  left: 1,
  right: 2,
  middle: 4,
} as const;

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false };

export interface DragBinding {
  /** `PointerEvent.buttons` mask that must be held exactly. */
  buttons: number;
  /** Modifiers that must be held. Unlisted modifiers are ignored. */
  modifiers?: Partial<Modifiers>;
  action: Exclude<NavAction, 'none'>;
}

export type PresetId = 'onshape' | 'fusion' | 'freecad';

export interface NavigationPreset {
  id: PresetId;
  label: string;
  /** Checked in order; the first match wins, so put the most specific first. */
  bindings: readonly DragBinding[];
  /** Wheel away from the user zooms in (true for all presets so far). */
  wheelForwardZoomsIn: boolean;
  /** Human readable summary for the help text and user docs. */
  summary: readonly string[];
}

export const PRESETS: Readonly<Record<PresetId, NavigationPreset>> = {
  onshape: {
    id: 'onshape',
    label: 'Onshape',
    bindings: [
      { buttons: Buttons.right, modifiers: { shift: true }, action: 'pan' },
      { buttons: Buttons.right, modifiers: { ctrl: true }, action: 'pan' },
      { buttons: Buttons.right, action: 'orbit' },
      { buttons: Buttons.middle, action: 'pan' },
    ],
    wheelForwardZoomsIn: true,
    summary: [
      'Right drag: orbit',
      'Middle drag, Shift or Ctrl + right drag: pan',
      'Wheel: zoom at the cursor',
    ],
  },
  fusion: {
    id: 'fusion',
    label: 'Fusion style',
    bindings: [
      { buttons: Buttons.middle, modifiers: { shift: true }, action: 'orbit' },
      { buttons: Buttons.middle, action: 'pan' },
    ],
    wheelForwardZoomsIn: true,
    summary: ['Shift + middle drag: orbit', 'Middle drag: pan', 'Wheel: zoom at the cursor'],
  },
  freecad: {
    id: 'freecad',
    label: 'FreeCAD (CAD style)',
    bindings: [
      { buttons: Buttons.middle | Buttons.left, action: 'orbit' },
      { buttons: Buttons.middle | Buttons.right, action: 'orbit' },
      { buttons: Buttons.middle, modifiers: { ctrl: true }, action: 'zoom' },
      { buttons: Buttons.middle, action: 'pan' },
    ],
    wheelForwardZoomsIn: true,
    summary: [
      'Middle + left or middle + right drag: orbit',
      'Middle drag: pan',
      'Ctrl + middle drag or wheel: zoom',
    ],
  },
};

export const DEFAULT_PRESET: PresetId = 'onshape';

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && Object.hasOwn(PRESETS, value);
}

function modifiersMatch(required: Partial<Modifiers> | undefined, held: Modifiers): boolean {
  if (!required) return true;
  return (Object.keys(required) as (keyof Modifiers)[]).every((k) => required[k] === held[k]);
}

/** The camera action for the held buttons and modifiers, or 'none' (selection). */
export function dragAction(preset: NavigationPreset, buttons: number, mods: Modifiers): NavAction {
  for (const b of preset.bindings) {
    if (b.buttons === buttons && modifiersMatch(b.modifiers, mods)) return b.action;
  }
  return 'none';
}

/**
 * Zoom factor applied to the view height for one wheel event: below 1 zooms
 * in. `deltaY` is normalised to pixels by the caller.
 */
export function wheelZoomFactor(preset: NavigationPreset, deltaY: number): number {
  const signed = preset.wheelForwardZoomsIn ? deltaY : -deltaY;
  // Clamp, so one fast flick on a free-spinning wheel cannot jump across the model.
  const step = Math.max(-200, Math.min(200, signed));
  return Math.exp(step * 0.0015);
}

/** Pixels from a WheelEvent delta in any `deltaMode` (0 px, 1 lines, 2 pages). */
export function wheelDeltaPixels(deltaY: number, deltaMode: number, pageHeight = 800): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}
