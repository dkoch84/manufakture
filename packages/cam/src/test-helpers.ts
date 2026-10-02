// Shared fixtures for the package's tests.

import type { IrEntry, Toolpath } from './ir';

/**
 * A small valid program: tool change, spindle on, rapid down, plunge, a straight cut, a half
 * circle, a lead move, a ramp, a dwell, a helical full turn, rapid up, spindle off.
 */
export function sampleToolpath(): Toolpath {
  const op = 'profile#1';
  const entries: IrEntry[] = [
    { kind: 'comment', text: 'Profile', op },
    { kind: 'toolChange', tool: 'tool#1', number: 201, name: '1/4in flat', op },
    { kind: 'spindle', state: 'cw', rpm: 18000, op },
    { kind: 'rapid', to: [0, 0, 5], op, pass: 0 },
    { kind: 'linear', to: [0, 0, -1], feed: 300, feedClass: 'plunge', op, pass: 0 },
    { kind: 'linear', to: [30, 40, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
    // Half turn about (30, 30) from (30, 40) to (30, 20), counter-clockwise: through x = 20.
    {
      kind: 'arc',
      to: [30, 20, -1],
      center: [30, 30],
      direction: 'ccw',
      fullCircle: false,
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    },
    { kind: 'linear', to: [40, 20, -1], feed: 500, feedClass: 'lead', op, pass: 0 },
    { kind: 'linear', to: [50, 20, -2], feed: 400, feedClass: 'ramp', op, pass: 1 },
    { kind: 'dwell', seconds: 1.5, op },
    // A helical full turn of radius 2 about (48, 20), down 1 mm.
    {
      kind: 'arc',
      to: [50, 20, -3],
      center: [48, 20],
      direction: 'cw',
      fullCircle: true,
      feed: 400,
      feedClass: 'ramp',
      op,
      pass: 1,
    },
    { kind: 'rapid', to: [50, 20, 10], op, pass: 1 },
    { kind: 'spindle', state: 'off', op },
  ];
  return { start: [0, 0, 10], entries };
}
