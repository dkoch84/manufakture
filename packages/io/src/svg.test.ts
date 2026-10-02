// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { drawingToSvg, displayListToSheet } from './drawing-export';
import { HELVETICA_CAP_HEIGHT } from './helvetica';
import {
  baselinePoint,
  itemsByLayer,
  pageOf,
  polylinePath,
  segmentPoint,
  signedSweep,
  type Path2,
  type Sheet2,
  type Text2,
  type Vec2,
} from './path2';
import { PLATE_SHEET, SHAPES_SHEET, bracketSheet } from './sheet-test-helpers';
import { escapeXml, layerId, writeSvg } from './svg';

function parseSvg(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

interface Piece {
  cmd: 'M' | 'L' | 'A' | 'Z';
  to: Vec2;
  arc?: { rx: number; ry: number; rot: number; large: boolean; sweep: boolean; from: Vec2 };
}

/** M, L, A and Z commands, absolute, in page coordinates. */
function parsePath(d: string): Piece[] {
  const tokens = d.match(/[MLAZ]|-?[\d.]+/g)!;
  const out: Piece[] = [];
  let i = 0;
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++] as Piece['cmd'];
    if (cmd === 'Z') {
      out.push({ cmd, to: start });
      cur = start;
    } else if (cmd === 'A') {
      const [rx, ry, rot, large, sweep, x, y] = [num(), num(), num(), num(), num(), num(), num()];
      out.push({
        cmd,
        to: [x, y],
        arc: { rx, ry, rot, large: !!large, sweep: !!sweep, from: cur },
      });
      cur = [x, y];
    } else {
      cur = [num(), num()];
      if (cmd === 'M') start = cur;
      out.push({ cmd, to: cur });
    }
  }
  return out;
}

/** The centre of an SVG arc (SVG 1.1 implementation notes, F.6.5), page coordinates. */
function arcCenter(p: Piece): Vec2 {
  const { rx, ry, rot, large, sweep, from } = p.arc!;
  const phi = (rot * Math.PI) / 180;
  const [c, s] = [Math.cos(phi), Math.sin(phi)];
  const dx = (from[0] - p.to[0]) / 2;
  const dy = (from[1] - p.to[1]) / 2;
  const x1 = c * dx + s * dy;
  const y1 = -s * dx + c * dy;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  return [c * cx1 - s * cy1 + (from[0] + p.to[0]) / 2, s * cx1 + c * cy1 + (from[1] + p.to[1]) / 2];
}

const TOL = 1e-6;
const near = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 5);
  expect(a[1]).toBeCloseTo(b[1], 5);
};

/** Checks that an SVG path is exactly the source path's geometry (to the six decimals written). */
function expectSameGeometry(piece: Piece[], path: Path2, flip: (p: Vec2) => Vec2): void {
  let k = 0;
  let prevEnd: Vec2 | undefined;
  for (const seg of path.segments) {
    const s = segmentPoint(seg, 'start');
    if (!prevEnd || Math.hypot(prevEnd[0] - s[0], prevEnd[1] - s[1]) > TOL) {
      expect(piece[k]!.cmd).toBe('M');
      near(piece[k++]!.to, flip(s));
    }
    if (seg.kind === 'line') {
      expect(piece[k]!.cmd).toBe('L');
      near(piece[k++]!.to, flip(seg.b));
    } else {
      const sweep = signedSweep(seg);
      const pieces = Math.abs(sweep) >= 2 * Math.PI - 1e-9 ? 2 : 1;
      for (let j = 1; j <= pieces; j++) {
        const p = piece[k++]!;
        expect(p.cmd).toBe('A');
        const [rx, ry, rot] =
          seg.kind === 'arc' ? [seg.radius, seg.radius, 0] : [seg.major, seg.minor, seg.rotation];
        expect([p.arc!.rx, p.arc!.ry]).toEqual([rx, ry].map((v) => Number(v.toFixed(6))));
        expect(p.arc!.rot).toBeCloseTo(rot === 0 ? 0 : -(rot * 180) / Math.PI, 5);
        // Counter-clockwise on paper is sweep-flag 0 once y points down.
        expect(p.arc!.sweep).toBe(sweep < 0);
        near(p.to, flip(segmentPoint({ ...seg, end: seg.start + (sweep / pieces) * j }, 'end')));
        // The centre is recovered through a square root that is flat at a half turn, so the
        // endpoints' 1e-6 rounding moves it by up to about 1e-3 there; elsewhere far less.
        const c = arcCenter(p);
        const fc = flip(seg.center);
        expect(Math.hypot(c[0] - fc[0], c[1] - fc[1])).toBeLessThan(1e-3);
      }
    }
    prevEnd = segmentPoint(seg, 'end');
  }
  if (path.closed) expect(piece[k++]!.cmd).toBe('Z');
  expect(k).toBe(piece.length);
}

function checkSheet(sheet: Sheet2): Document {
  const text = writeSvg(sheet);
  const doc = parseSvg(text);
  const page = pageOf(sheet);
  const flip = (p: Vec2): Vec2 => [p[0] - page.origin[0], page.height - (p[1] - page.origin[1])];
  const groups = itemsByLayer(sheet).filter((g) => g.items.length);
  const gs = [...doc.documentElement.children].filter((e) => e.tagName === 'g');
  expect(gs.map((g) => g.getAttribute('data-layer'))).toEqual(groups.map((g) => g.layer.name));
  groups.forEach(({ layer, items }, i) => {
    const g = gs[i]!;
    expect(g.getAttribute('stroke-width')).toBe(String(layer.weight ?? 0.25));
    expect(g.getAttribute('stroke-dasharray')).toBe(
      layer.dash?.length ? layer.dash.join(' ') : null,
    );
    const elements = [...g.children];
    expect(elements).toHaveLength(items.length);
    items.forEach((item, j) => {
      const el = elements[j]!;
      expect(el.getAttribute('data-owner')).toBe(item.owner ?? null);
      if (item.kind === 'path') {
        expect(el.tagName).toBe('path');
        expect(el.getAttribute('fill')).toBe(item.fill ? '#000000' : null);
        expectSameGeometry(parsePath(el.getAttribute('d')!), item, flip);
      } else checkText(el, item, flip);
    });
  });
  return doc;
}

function checkText(el: Element, t: Text2, flip: (p: Vec2) => Vec2): void {
  expect(el.tagName).toBe('text');
  expect(el.textContent).toBe(t.text);
  const p = flip(baselinePoint(t));
  expect(Number(el.getAttribute('x'))).toBeCloseTo(p[0], 5);
  expect(Number(el.getAttribute('y'))).toBeCloseTo(p[1], 5);
  expect(Number(el.getAttribute('font-size'))).toBeCloseTo(t.height / HELVETICA_CAP_HEIGHT, 5);
  expect(el.getAttribute('font-family')).toBe('Helvetica, Arial, sans-serif');
  expect(el.getAttribute('text-anchor') ?? 'start').toBe(t.anchor);
  const rotate = el.getAttribute('transform');
  if (t.rotation === 0) expect(rotate).toBeNull();
  else
    expect(rotate).toBe(
      `rotate(${-(t.rotation * 180) / Math.PI} ${el.getAttribute('x')} ${el.getAttribute('y')})`,
    );
}

describe('writeSvg', () => {
  it('writes the M1 bracket drawing: paper in mm, viewBox, every item back exactly', () => {
    const sheet = displayListToSheet(bracketSheet(), { title: 'M1 bracket' });
    const doc = checkSheet(sheet);
    const svg = doc.documentElement;
    expect(svg.getAttribute('width')).toBe('420mm');
    expect(svg.getAttribute('height')).toBe('297mm');
    expect(svg.getAttribute('viewBox')).toBe('0 0 420 297');
    expect(doc.getElementsByTagName('title')[0]!.textContent).toBe('M1 bracket');
    // Hidden lines dashed, butt-capped.
    const hidden = doc.getElementById('layer-hidden')!;
    expect(hidden.getAttribute('stroke-dasharray')).toBe('3 1.5');
    expect(hidden.getAttribute('stroke-linecap')).toBe('butt');
    expect(hidden.children.length).toBeGreaterThan(0);
    const texts = [...doc.getElementsByTagName('text')].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(['M1 bracket', 'MK-0001', '2x Ø8 CBORE']));
  });

  it('writes ellipse arcs, wrapping and full arcs, rotated text, fills and hatching', () => {
    const doc = checkSheet(displayListToSheet(SHAPES_SHEET));
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 210 297');
    const hatch = doc.getElementById('layer-hatch')!.children[0]!.getAttribute('d')!;
    expect(hatch.match(/M/g)!.length).toBeGreaterThan(20);
  });

  it('pages a sheet without a size by its bounds (a laser part)', () => {
    const doc = checkSheet(PLATE_SHEET);
    const svg = doc.documentElement;
    expect([svg.getAttribute('width'), svg.getAttribute('viewBox')]).toEqual(['60mm', '0 0 60 40']);
    expect(doc.getElementById('layer-cut')!.getAttribute('stroke')).toBe('#ff0000');
  });

  it('escapes text and drops what XML cannot hold', () => {
    expect(escapeXml('a<b>&"c"\u0001\ud800')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(layerId('title block/1')).toBe('layer-title_block_1');
    const text = drawingToSvg({
      width: 100,
      height: 100,
      layers: SHAPES_SHEET.layers,
      items: [
        {
          kind: 'text',
          layer: 'text',
          at: [10, 10],
          text: '  <A & B>  ',
          height: 3,
          rotation: 0,
          anchor: 'start',
          baseline: 'bottom',
        },
      ],
      warnings: [],
    });
    const el = parseSvg(text).getElementsByTagName('text')[0]!;
    expect(el.textContent).toBe('  <A & B>  ');
    expect(el.getAttribute('xml:space')).toBe('preserve');
  });

  it('writes only #rrggbb colours (anything else as black) and no negative dashes', () => {
    const sheet: Sheet2 = {
      layers: [
        { name: 'bad', color: '"/><script>alert(1)</script><x a="', dash: [-3, 1] },
        { name: 'short', color: '#f00' },
        { name: 'ok', color: '#00FF00', dash: [-1, -1] },
      ],
      items: [
        {
          ...polylinePath(
            'bad',
            [
              [0, 0],
              [10, 10],
            ],
            { fill: true },
          ),
        },
        polylinePath('short', [
          [0, 0],
          [10, 0],
        ]),
        polylinePath('ok', [
          [0, 10],
          [10, 0],
        ]),
      ],
    };
    const text = writeSvg(sheet);
    expect(text).not.toContain('script');
    const doc = parseSvg(text);
    const bad = doc.getElementById('layer-bad')!;
    expect(bad.getAttribute('stroke')).toBe('#000000');
    expect(bad.getAttribute('stroke-dasharray')).toBe('0 1');
    expect(bad.getElementsByTagName('path')[0]!.getAttribute('fill')).toBe('#000000');
    expect(doc.getElementById('layer-short')!.getAttribute('stroke')).toBe('#000000');
    const ok = doc.getElementById('layer-ok')!;
    expect(ok.getAttribute('stroke')).toBe('#00ff00');
    expect(ok.hasAttribute('stroke-dasharray')).toBe(false);
  });
});
