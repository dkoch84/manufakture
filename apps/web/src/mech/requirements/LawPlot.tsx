// The resistance law of a load case, plotted from the law itself (T9.4a): force against cable
// extension (pulling and returning at the motion's peak speeds) and force against cable speed (at
// mid-stroke; negative speeds are the return). Forces in the document's display unit.

import type { DisplayUnits } from '@manufakture/core';
import type { CurvePoint, ForceCurves } from '@manufakture/domain-mech';
import { resolveDisplayUnit, toDisplayUnit } from '@manufakture/units';

const W = 300;
const H = 170;
const PAD = { left: 46, right: 10, top: 10, bottom: 30 };

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function label(v: number): string {
  return String(Number(v.toPrecision(3)));
}

interface Series {
  points: readonly CurvePoint[];
  className: string;
  name: string;
}

function Chart({
  testId,
  title,
  xLabel,
  xFrom,
  xTo,
  series,
  forceUnit,
}: {
  testId: string;
  title: string;
  xLabel: string;
  xFrom: number;
  xTo: number;
  series: readonly Series[];
  forceUnit: string;
}) {
  const fMax = niceMax(
    Math.max(
      ...series.flatMap((s) => s.points.map(([, f]) => toDisplayUnit(f, 'force', forceUnit))),
    ),
  );
  const sx = (v: number) =>
    PAD.left + ((v - xFrom) / (xTo - xFrom || 1)) * (W - PAD.left - PAD.right);
  const sy = (f: number) =>
    H - PAD.bottom - (toDisplayUnit(f, 'force', forceUnit) / fMax) * (H - PAD.top - PAD.bottom);
  const path = (pts: readonly CurvePoint[]) =>
    pts
      .map(([v, f], i) => `${i === 0 ? 'M' : 'L'}${sx(v).toFixed(2)},${sy(f).toFixed(2)}`)
      .join(' ');
  return (
    <figure className="law-plot" data-testid={testId}>
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <line
          className="law-axis"
          x1={PAD.left}
          y1={H - PAD.bottom}
          x2={W - PAD.right}
          y2={H - PAD.bottom}
        />
        <line className="law-axis" x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} />
        {xFrom < 0 && xTo > 0 && (
          <line className="law-zero" x1={sx(0)} y1={PAD.top} x2={sx(0)} y2={H - PAD.bottom} />
        )}
        <text className="law-tick" x={PAD.left - 4} y={PAD.top + 4} textAnchor="end">
          {label(fMax)}
        </text>
        <text className="law-tick" x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end">
          0
        </text>
        <text
          className="law-tick"
          x={PAD.left - 30}
          y={(H - PAD.bottom + PAD.top) / 2}
          textAnchor="middle"
        >
          {forceUnit}
        </text>
        <text className="law-tick" x={PAD.left} y={H - PAD.bottom + 12} textAnchor="middle">
          {label(xFrom)}
        </text>
        <text className="law-tick" x={W - PAD.right} y={H - PAD.bottom + 12} textAnchor="end">
          {label(xTo)}
        </text>
        <text className="law-tick" x={(W + PAD.left) / 2} y={H - 4} textAnchor="middle">
          {xLabel}
        </text>
        {series.map((s) => (
          <path
            key={s.name}
            className={`law-line ${s.className}`}
            d={path(s.points)}
            data-series={s.name}
          >
            <title>{s.name}</title>
          </path>
        ))}
      </svg>
      {series.length > 1 && (
        <p className="law-legend">
          {series.map((s) => (
            <span key={s.name} className={s.className}>
              {s.name}
            </span>
          ))}
        </p>
      )}
    </figure>
  );
}

export function LawPlot({ curves, units }: { curves: ForceCurves; units: DisplayUnits }) {
  const forceUnit = resolveDisplayUnit('force', units.quantities, units.length.unit);
  const v = (x: number) => label(x);
  return (
    <div className="law-plots">
      <Chart
        testId="lc-plot-position"
        title="Force against extension"
        xLabel="extension, m"
        xFrom={curves.byPosition.from}
        xTo={curves.byPosition.to}
        forceUnit={forceUnit}
        series={[
          {
            points: curves.byPosition.pull,
            className: 'law-pull',
            name: `pull at ${v(curves.pullSpeed)} m/s`,
          },
          {
            points: curves.byPosition.return,
            className: 'law-return',
            name: `return at ${v(curves.returnSpeed)} m/s`,
          },
        ]}
      />
      <Chart
        testId="lc-plot-speed"
        title="Force against speed"
        xLabel={`speed, m/s (at ${v(curves.bySpeed.at)} m; below 0 the return)`}
        xFrom={curves.bySpeed.from}
        xTo={curves.bySpeed.to}
        forceUnit={forceUnit}
        series={[{ points: curves.bySpeed.points, className: 'law-pull', name: 'force' }]}
      />
    </div>
  );
}
