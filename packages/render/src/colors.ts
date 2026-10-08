// The fixed colours of a render: background, ink, highlight, and the default colours of bodies
// and framing members, which are the app's (apps/web `BODY_PALETTE` and the viewport's lumber
// tones by role), so a render looks like the viewport.

import type { Rgb } from './types';

export const BACKGROUND: Rgb = [0xf6, 0xf7, 0xf9];
export const INK: Rgb = [0x1f, 0x23, 0x28];
/** Highlighted bodies, members and faces. */
export const HIGHLIGHT: Rgb = [0xf0, 0x8a, 0x24];
/** Highlighted edges, darker so they read on a highlighted face too. */
export const HIGHLIGHT_EDGE: Rgb = [0xc2, 0x41, 0x0c];

/** Default body colours by body order in the part, as the app's `BODY_PALETTE`. */
export const BODY_PALETTE: readonly string[] = [
  '#c2cad3',
  '#8fb8de',
  '#e0b27a',
  '#9ccc9c',
  '#d69ab8',
  '#c9c07a',
  '#8fd0cc',
  '#b8a3d9',
];

/** Lumber tones by member role, as the app's viewport draws them. */
const ROLE_COLORS: Readonly<Record<string, string>> = {
  'bottom-plate': '#c49a63',
  'top-plate': '#c49a63',
  stud: '#e0c39a',
  corner: '#e0c39a',
  backing: '#e0c39a',
  king: '#d6b07d',
  jack: '#cfa36c',
  header: '#b78450',
  'header-spacer': '#b78450',
  'rough-sill': '#cfa36c',
  cripple: '#e6cfa9',
  blocking: '#e6cfa9',
  joist: '#d2a776',
  rim: '#bf915e',
  skid: '#9c7a52',
  'common-rafter': '#c99a66',
  'jack-rafter': '#c99a66',
  'hip-rafter': '#ad7a46',
  'fly-rafter': '#c99a66',
  ridge: '#ad7a46',
  'ceiling-joist': '#d2a776',
  'rafter-tie': '#d2a776',
  'gable-stud': '#e0c39a',
  'sub-fascia': '#a7774a',
  fascia: '#a7774a',
};

export const DEFAULT_MEMBER_COLOR = '#dcbf94';

export function memberColor(role: string): string {
  return ROLE_COLORS[role] ?? DEFAULT_MEMBER_COLOR;
}

/** `#rrggbb` to bytes; anything else is the first palette colour. */
export function parseColor(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const v = parseInt(m ? m[1]! : BODY_PALETTE[0]!.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
