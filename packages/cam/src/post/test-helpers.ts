// Shared fixtures for the post engine's tests: a Grbl-like dialect record.

import type { Dialect } from './dialect';

/** A Grbl 1.1 style dialect for tests; `over` replaces fields. */
export function testDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    id: 'test-grbl',
    name: 'Test Grbl',
    gCodes: ['G0', 'G1', 'G2', 'G3', 'G4', 'G17', 'G20', 'G21', 'G90', 'G91.1', 'G94'],
    mCodes: ['M0', 'M2', 'M3', 'M5', 'M30'],
    toolChange: 'none',
    splitPerTool: true,
    cannedCycles: false,
    fullCircles: 'halves',
    comments: 'parentheses',
    maxLineLength: 80,
    programDelimiter: false,
    dwellUnit: 'seconds',
    decimals: {
      mm: { coordinate: 3, feed: 0 },
      inch: { coordinate: 4, feed: 1 },
      spindle: 0,
      dwell: 3,
    },
    templates: {
      header: [
        '({job} / {setup}, {date})',
        '(Post {post}, {units}, file {file_index} of {file_count})',
      ],
      tool: ['(T{tool} {tool_name} D{tool_diameter})'],
      toolChange: ['(Tool {tool}: {tool_name}, {rpm} rpm, F{feed})'],
      footer: ['M30'],
    },
    ...over,
  };
}
