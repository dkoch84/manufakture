// One sheet layout or lumber stick drawn to scale (M4 plan T4.3d): parts with their cut list
// numbers, offcuts dashed, waste shaded, and for a sheet its cut order. Each figure is skipped by
// the browser's layout while off screen (`content-visibility: auto` in cutlist.css), so a kitchen
// of twenty sheets scrolls like a bookshelf of two.

import { cutSequence, type SheetLayout, type StickLayout } from '@manufakture/nesting';
import { formatLength, type LengthFormat } from '@manufakture/units';
import type { DisplayRow } from '@manufakture/domain-wood';

export interface SheetViewProps {
  sheet: SheetLayout;
  title: string;
  labels: ReadonlyMap<string, DisplayRow>;
  format: LengthFormat;
  /** A row to emphasise (hovered or picked in the list). */
  highlight?: string | null;
  testId?: string;
}

export function SheetView({ sheet, title, labels, format, highlight, testId }: SheetViewProps) {
  const len = (mm: number) => formatLength(mm, format);
  const cuts = cutSequence(sheet);
  // Text sized from the sheet so it reads the same on any sheet: about 1/40 of the long side.
  const th = Math.max(sheet.length, sheet.width) / 40;
  return (
    <figure className="cutlist-sheet" data-testid={testId}>
      <figcaption>
        <strong>{title}</strong>{' '}
        <span className="field-note">
          {len(sheet.length)} x {len(sheet.width)}; waste {sheet.wastePercent.toFixed(1)}%
          {sheet.offcuts.length > 0 &&
            `; ${sheet.offcuts.length} ${sheet.offcuts.length === 1 ? 'offcut' : 'offcuts'}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${sheet.length} ${sheet.width}`}
        role="img"
        aria-label={`${title}: ${sheet.placements.length} parts`}
        preserveAspectRatio="xMidYMid meet"
      >
        <rect className="cutlist-waste" x={0} y={0} width={sheet.length} height={sheet.width} />
        {sheet.offcuts.map((o, i) => (
          <rect
            key={`o${i}`}
            className="cutlist-offcut"
            x={o.x}
            y={sheet.width - o.y - o.sizeY}
            width={o.sizeX}
            height={o.sizeY}
          />
        ))}
        {sheet.placements.map((p, i) => {
          const row = labels.get(p.partId);
          const y = sheet.width - p.y - p.sizeY;
          const size = Math.min(th, p.sizeY / 2.5, p.sizeX / 2.5);
          return (
            <g
              key={i}
              className={`cutlist-part${highlight === p.partId ? ' highlighted' : ''}`}
              data-part={p.partId}
            >
              <title>{`${row ? `${row.number}. ${row.fullItem}` : p.partId}: ${len(p.rotated ? p.sizeY : p.sizeX)} x ${len(p.rotated ? p.sizeX : p.sizeY)}`}</title>
              <rect x={p.x} y={y} width={p.sizeX} height={p.sizeY} />
              <text
                x={p.x + p.sizeX / 2}
                y={y + p.sizeY / 2}
                fontSize={size}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {row ? row.number : '?'}
              </text>
            </g>
          );
        })}
        <rect className="cutlist-outline" x={0} y={0} width={sheet.length} height={sheet.width} />
      </svg>
      <details className="cutlist-cuts">
        <summary>Cut order ({cuts.length})</summary>
        <ol>
          {cuts.map((c) => (
            <li key={c.step}>
              {c.kind === 'trim' ? 'Trim' : c.kind === 'rip' ? 'Rip' : 'Crosscut'} at{' '}
              {len(c.at - (c.axis === 'x' ? c.piece.x : c.piece.y))}
            </li>
          ))}
        </ol>
      </details>
    </figure>
  );
}

export interface StickViewProps {
  stick: StickLayout;
  labels: ReadonlyMap<string, DisplayRow>;
  format: LengthFormat;
  highlight?: string | null;
}

export function StickView({ stick, labels, format, highlight }: StickViewProps) {
  const len = (mm: number) => formatLength(mm, format);
  const h = stick.length / 24;
  return (
    <figure className="cutlist-stick" data-testid="cutlist-stick">
      <figcaption className="field-note">
        {len(stick.length)}: {stick.cuts.map((c) => len(c.length)).join(', ')}; waste{' '}
        {stick.wastePercent.toFixed(1)}%
      </figcaption>
      <svg
        viewBox={`0 0 ${stick.length} ${h}`}
        role="img"
        aria-label={`${len(stick.length)} stick`}
      >
        <rect className="cutlist-waste" x={0} y={0} width={stick.length} height={h} />
        {stick.offcut && (
          <rect
            className="cutlist-offcut"
            x={stick.offcut.start}
            y={0}
            width={stick.offcut.length}
            height={h}
          />
        )}
        {stick.cuts.map((c, i) => {
          const row = labels.get(c.partId);
          return (
            <g
              key={i}
              className={`cutlist-part${highlight === c.partId ? ' highlighted' : ''}`}
              data-part={c.partId}
            >
              <title>{`${row ? `${row.number}. ${row.fullItem}` : c.partId}: ${len(c.length)}`}</title>
              <rect x={c.start} y={0} width={c.length} height={h} />
              <text
                x={c.start + c.length / 2}
                y={h / 2}
                fontSize={h * 0.6}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {row ? row.number : '?'}
              </text>
            </g>
          );
        })}
        <rect className="cutlist-outline" x={0} y={0} width={stick.length} height={h} />
      </svg>
    </figure>
  );
}
