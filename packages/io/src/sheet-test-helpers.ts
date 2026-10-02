// Test-only sheets; not exported from the package. The M1 bracket's three-view drawing is the
// same input as the drawing package's own golden (packages/drawing/src/drawing.test.ts), laid
// out from its fixture edges; the shapes sheet covers what the bracket lacks: ellipse arcs,
// clockwise and rotated items, text on every anchor and baseline, hatching.

import {
  DEFAULT_LAYERS,
  layoutSheet,
  type DisplayItem,
  type DisplayList,
  type DrawingInput,
} from '@manufakture/drawing';
import { BRACKET_FRONT, BRACKET_RIGHT, BRACKET_TOP } from '@manufakture/drawing/fixtures';
import { line, type Sheet2 } from './path2';

/** The M1 bracket's third-angle drawing on A3 at 2:1, with dimensions, a note and a title block. */
export const BRACKET_DRAWING: DrawingInput = {
  sheet: { size: 'A3' },
  scale: { paper: 2, model: 1 },
  views: [
    { id: 'view#1', edges: BRACKET_FRONT, position: [110, 130] },
    {
      id: 'view#2',
      edges: BRACKET_TOP,
      align: { parent: 'view#1', direction: 'vertical' },
      position: [0, 230],
    },
    {
      id: 'view#3',
      edges: BRACKET_RIGHT,
      align: { parent: 'view#1', direction: 'horizontal' },
      position: [240, 0],
    },
  ],
  dimensions: [
    {
      id: 'dim#1',
      view: 'view#1',
      kind: 'vertical',
      points: [
        [0, 0],
        [0, 40],
      ],
      offset: -10,
    },
    {
      id: 'dim#2',
      view: 'view#1',
      kind: 'horizontal',
      points: [
        [0, 0],
        [50, 0],
      ],
      offset: -10,
    },
    {
      id: 'dim#3',
      view: 'view#1',
      kind: 'vertical',
      points: [
        [50, 0],
        [50, 6],
      ],
      offset: 10,
    },
    {
      id: 'dim#4',
      view: 'view#1',
      kind: 'radius',
      circle: { center: [10, 10], radius: 4 },
      angle: (5 * Math.PI) / 4,
      textSide: 'inside',
    },
    {
      id: 'dim#5',
      view: 'view#2',
      kind: 'horizontal',
      points: [
        [25, 0],
        [40, 0],
      ],
      offset: 40,
    },
    {
      id: 'dim#6',
      view: 'view#2',
      kind: 'diameter',
      circle: { center: [40, 0], radius: 4 },
      angle: -Math.PI / 4,
      text: '2x <> CBORE',
    },
    {
      id: 'dim#7',
      view: 'view#3',
      kind: 'horizontal',
      points: [
        [-15, 0],
        [15, 0],
      ],
      offset: -10,
    },
  ],
  notes: [
    {
      id: 'note#1',
      text: 'BREAK ALL SHARP EDGES\nMATERIAL 6061-T6',
      at: [40, 70],
    },
  ],
  titleBlock: { title: 'M1 bracket', drawingNumber: 'MK-0001', revision: 'A', units: 'mm' },
};

export const bracketSheet = (): DisplayList => layoutSheet(BRACKET_DRAWING);

const SHAPE_ITEMS: DisplayItem[] = [
  {
    kind: 'polyline',
    layer: 'border',
    points: [
      [10, 10],
      [200, 10],
      [200, 287],
      [10, 287],
    ],
    closed: true,
    owner: 'border',
  },
  // A hole seen at an angle: a full ellipse, and the hidden half of another.
  {
    kind: 'ellipseArc',
    layer: 'visible',
    center: [60, 220],
    major: 20,
    minor: 8,
    rotation: Math.PI / 6,
    start: 0,
    end: 2 * Math.PI,
    owner: 'view#1',
    item: 0,
  },
  {
    kind: 'ellipseArc',
    layer: 'hidden',
    center: [60, 200],
    major: 20,
    minor: 8,
    rotation: Math.PI / 6,
    start: Math.PI,
    end: 2 * Math.PI,
    owner: 'view#1',
    item: 0,
  },
  // Minor larger than major: DXF swaps the axes.
  {
    kind: 'ellipseArc',
    layer: 'visible',
    center: [150, 220],
    major: 5,
    minor: 15,
    rotation: 0,
    start: -Math.PI / 2,
    end: Math.PI / 2,
    owner: 'view#1',
    item: 1,
  },
  // An arc whose end angle is below its start (it wraps through 0), and a full circle.
  {
    kind: 'arc',
    layer: 'visible',
    center: [60, 120],
    radius: 15,
    start: (3 * Math.PI) / 2,
    end: Math.PI / 2,
    owner: 'view#2',
  },
  {
    kind: 'arc',
    layer: 'visible',
    center: [140, 120],
    radius: 10,
    start: 0,
    end: 2 * Math.PI,
    owner: 'view#2',
  },
  { kind: 'line', layer: 'centre', a: [125, 120], b: [155, 120], owner: 'view#2' },
  {
    kind: 'polyline',
    layer: 'smooth',
    points: [
      [20, 60],
      [40, 70],
      [60, 60],
      [80, 70],
    ],
    owner: 'view#2',
  },
  {
    kind: 'polyline',
    layer: 'dimension',
    points: [
      [100, 60],
      [103, 59.5],
      [103, 60.5],
    ],
    closed: true,
    fill: true,
    owner: 'dim#1',
  },
  { kind: 'line', layer: 'section', a: [20, 160], b: [190, 160], owner: 'view#2' },
  {
    kind: 'hatch',
    layer: 'hatch',
    loops: [
      [
        { kind: 'line', a: [120, 40], b: [180, 40] },
        { kind: 'line', a: [180, 40], b: [180, 80] },
        { kind: 'line', a: [180, 80], b: [120, 80] },
        { kind: 'line', a: [120, 80], b: [120, 40] },
      ],
      [{ kind: 'arc', center: [150, 60], radius: 8, start: 0, end: 2 * Math.PI }],
    ],
    angle: Math.PI / 4,
    spacing: 3,
    owner: 'view#2',
  },
  {
    kind: 'text',
    layer: 'text',
    at: [30, 30],
    text: 'Ø8 THRU',
    height: 3.5,
    rotation: 0,
    anchor: 'start',
    baseline: 'bottom',
    owner: 'note#1',
  },
  {
    kind: 'text',
    layer: 'text',
    at: [105, 30],
    text: 'R15 <45°> ±0.1',
    height: 3.5,
    rotation: 0,
    anchor: 'middle',
    baseline: 'middle',
    owner: 'note#2',
  },
  {
    kind: 'text',
    layer: 'text',
    at: [190, 30],
    text: 'A & B "C"',
    height: 2.5,
    rotation: 0,
    anchor: 'end',
    baseline: 'top',
    owner: 'note#3',
  },
  {
    kind: 'text',
    layer: 'text',
    at: [15, 150],
    text: 'VERTICAL',
    height: 3.5,
    rotation: Math.PI / 2,
    anchor: 'start',
    baseline: 'bottom',
    owner: 'note#4',
  },
];

/** An A4 portrait sheet of the items a three-view of the bracket does not have. */
export const SHAPES_SHEET: DisplayList = {
  width: 210,
  height: 297,
  layers: DEFAULT_LAYERS,
  items: SHAPE_ITEMS,
  warnings: [],
};

const R = 5;
/**
 * A laser part as M5 T5.6a will write it: no paper size, one outer loop of lines and quarter arcs
 * (counter-clockwise, 60 x 40 with R5 corners) and a clockwise hole, on a `cut` layer.
 */
export const PLATE_SHEET: Sheet2 = {
  layers: [{ name: 'cut', weight: 0.1, color: '#ff0000' }],
  items: [
    {
      kind: 'path',
      layer: 'cut',
      owner: 'loop#1',
      closed: true,
      segments: [
        line([R, 0], [60 - R, 0]),
        { kind: 'arc', center: [60 - R, R], radius: R, start: -Math.PI / 2, end: 0 },
        line([60, R], [60, 40 - R]),
        { kind: 'arc', center: [60 - R, 40 - R], radius: R, start: 0, end: Math.PI / 2 },
        line([60 - R, 40], [R, 40]),
        { kind: 'arc', center: [R, 40 - R], radius: R, start: Math.PI / 2, end: Math.PI },
        line([0, 40 - R], [0, R]),
        { kind: 'arc', center: [R, R], radius: R, start: Math.PI, end: (3 * Math.PI) / 2 },
      ],
    },
    {
      kind: 'path',
      layer: 'cut',
      owner: 'loop#2',
      closed: true,
      segments: [{ kind: 'arc', center: [20, 20], radius: 4, start: 0, end: -2 * Math.PI }],
    },
  ],
};
