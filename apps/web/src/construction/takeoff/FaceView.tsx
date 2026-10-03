// One face's sheet layout drawn to scale (M6 plan T6.3b): the face's outline and openings, its
// pieces numbered by column and row from the starting corner, whole sheets plain, pieces from an
// offcut dashed and pieces cut from a new sheet shaded, and the cut-outs for openings hatched.
// Drawn like the cut list's sheet views (cutlist.css), y up the face.

import type { FaceLayout, SheetFace } from '@manufakture/domain-construction';
import { formatLength, type LengthFormat } from '@manufakture/units';

export interface FaceViewProps {
  face: SheetFace;
  layout: FaceLayout;
  title: string;
  format: LengthFormat;
  /** Emphasised: the face belongs to the picked row. */
  highlight?: boolean;
}

const FROM_TEXT = { sheet: 'whole sheet', offcut: 'from an offcut', new: 'cut from a new sheet' };

export function FaceView({ face, layout, title, format, highlight = false }: FaceViewProps) {
  const len = (mm: number) => formatLength(mm, format);
  const W = face.width;
  const H = face.height;
  const flip = (y: number, h: number) => H - y - h;
  const th = Math.max(W, H) / 40;
  const whole = layout.pieces.filter((p) => p.full).length;
  return (
    <figure
      className={`cutlist-sheet takeoff-face${highlight ? ' highlighted' : ''}`}
      data-testid="takeoff-face"
      data-face={face.id}
    >
      <figcaption>
        <strong>{title}</strong>{' '}
        <span className="field-note">
          {len(W)} x {len(H)}; {layout.pieces.length}{' '}
          {layout.pieces.length === 1 ? 'piece' : 'pieces'}, {whole} whole
          {layout.cutouts.length > 0 &&
            `; ${layout.cutouts.length} ${layout.cutouts.length === 1 ? 'cut-out' : 'cut-outs'}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${layout.pieces.length} pieces`}
        preserveAspectRatio="xMidYMid meet"
      >
        {face.outline ? (
          <polygon
            className="cutlist-waste"
            points={face.outline.map((p) => `${p[0]},${H - p[1]}`).join(' ')}
          />
        ) : (
          <rect className="cutlist-waste" x={0} y={0} width={W} height={H} />
        )}
        {layout.pieces.map((p) => (
          <g key={p.id} className={`cutlist-part takeoff-piece-${p.from}`}>
            <title>{`${p.id.slice(p.id.lastIndexOf('@') + 1)}: ${len(p.width)} x ${len(p.height)}, ${FROM_TEXT[p.from]}`}</title>
            <rect x={p.x} y={flip(p.y, p.height)} width={p.width} height={p.height} />
            {p.width > th * 2 && p.height > th * 1.5 && (
              <text
                x={p.x + p.width / 2}
                y={flip(p.y, p.height) + p.height / 2}
                fontSize={Math.min(th, p.height / 2.5)}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {p.id.slice(p.id.lastIndexOf('@') + 1)}
              </text>
            )}
          </g>
        ))}
        {layout.cutouts.map((c, i) => (
          <rect
            key={i}
            className="takeoff-cutout"
            x={c.x}
            y={flip(c.y, c.height)}
            width={c.width}
            height={c.height}
          />
        ))}
        {(face.holes ?? []).map((h, i) => (
          <rect
            key={`h${i}`}
            className="cutlist-outline"
            x={h.x}
            y={flip(h.y, h.height)}
            width={h.width}
            height={h.height}
          />
        ))}
        {face.outline ? (
          <polygon
            className="cutlist-outline"
            points={face.outline.map((p) => `${p[0]},${H - p[1]}`).join(' ')}
          />
        ) : (
          <rect className="cutlist-outline" x={0} y={0} width={W} height={H} />
        )}
      </svg>
    </figure>
  );
}
