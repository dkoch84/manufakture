// The Wall tool (side panel): draw a wall's path on the active level. Type each length in the
// document's units (`16'`, `11' 6-1/2"`) with its direction in 90 degree steps, or click points
// in the view, snapped to wall ends, square to the last point and to the grid; tick "Close the
// loop" (or end back on the start) for a building outline. The path is drawn in the view as it
// grows; Add wall adds one `construction.wall` feature, one undo step.

import type { DisplayUnits } from '@manufakture/core';
import type { ConstructionSettings, WallMetadata } from '@manufakture/domain-construction';
import { readWallMetadata } from '@manufakture/domain-construction';
import { formatLength } from '@manufakture/units';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../model/model';
import { evaluateVariables, lengthFormat } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import type { ViewportApi } from '../viewport/Viewport';
import { Select } from '../wood/Select';
import { Field } from './LevelsPanel';
import { checkLength, coordinateSource } from './lengths';
import type { ConstructionUiStore } from './state';
import {
  DIRECTIONS,
  DIRECTION_LABELS,
  SAME_POINT,
  buildWall,
  directionOf,
  gridFor,
  pathPoints,
  segmentLengths,
  snapPoint,
  turn,
  wallEnds,
  type Direction,
  type P2,
  type PathStep,
} from './walls';

export function WallTool({
  documents,
  model,
  ui,
  partId,
  settings,
  viewport,
  onClose,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  ui: ConstructionUiStore;
  partId: string;
  settings: ConstructionSettings | undefined;
  viewport: ViewportApi | null;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const units = doc.units;
  const levels = settings?.levels ?? [];
  const types = settings?.wallTypes ?? [];
  const chosenLevel = useStore(ui, (s) => s.level);
  const level = levels.find((l) => l.id === chosenLevel) ?? levels[0];
  const [wallType, setWallType] = useState(types[0]?.id ?? '');
  const [startX, setStartX] = useState('0');
  const [startY, setStartY] = useState('0');
  const [steps, setSteps] = useState<PathStep[]>([]);
  const [lengthText, setLengthText] = useState('');
  const [dir, setDir] = useState<Direction>(0);
  const [closed, setClosed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const variables = useMemo(() => evaluateVariables(doc), [doc]);

  const sx = checkLength(startX, units, variables, { sign: 'any' });
  const sy = checkLength(startY, units, variables, { sign: 'any' });
  const start: P2 | null = sx.ok && sy.ok ? [sx.value, sy.value] : null;
  const points = start ? pathPoints(start, steps) : [];

  // Other walls' ends on this level, for snapping clicks.
  const parts = useStore(model, (s) => s.parts);
  const others = useMemo(() => {
    const out: { id: string; meta: WallMetadata }[] = [];
    for (const f of parts.find((p) => p.partId === partId)?.features ?? []) {
      const m = readWallMetadata(f.metadata);
      if (m) out.push({ id: f.featureId, meta: m });
    }
    return out;
  }, [parts, partId]);
  const ends = useMemo(
    () =>
      level
        ? wallEnds(
            others.map((o) => o.meta),
            level.id,
          )
        : [],
    [others, level],
  );

  const addTyped = () => {
    const r = checkLength(lengthText, units, variables);
    if (!r.ok) {
      setErrors({ length: r.message });
      return;
    }
    setErrors({});
    setSteps((s) => [...s, { kind: 'typed', dir, length: r.value, text: lengthText.trim() }]);
    setLengthText('');
    // Framers lay out round the building: the next length turns left by default.
    setDir(turn(dir, 'left'));
  };

  // Clicks in the view, on the level's plane.
  const stepsRef = useRef(steps);
  const clickedStart = useRef(false);
  const latest = useRef({ points, ends, units, elevation: 0 });
  useEffect(() => {
    stepsRef.current = steps;
    latest.current = { points, ends, units, elevation: level ? levelElevation(level) : 0 };
  });
  useEffect(() => {
    if (!viewport) return;
    const plane = (x: number, y: number): P2 | null => {
      const z = latest.current.elevation;
      const hit = viewport.canvasToPlane(x, y, [0, 0, z], [0, 0, 1]);
      return hit ? [hit[0], hit[1]] : null;
    };
    const snapped = (raw: P2) => {
      const { points: pts, ends: e, units: u } = latest.current;
      return snapPoint(raw, {
        from: pts.at(-1),
        endpoints: [...e, ...pts],
        grid: gridFor(u),
        tolerance: gridFor(u) * 6,
      }).point;
    };
    viewport.setPointerDelegate({
      down(_e, p) {
        const raw = plane(p.x, p.y);
        if (!raw) return false;
        const q = snapped(raw);
        if (stepsRef.current.length === 0 && !clickedStart.current) {
          clickedStart.current = true;
          setStartX(coordinateSource(q[0], latest.current.units));
          setStartY(coordinateSource(q[1], latest.current.units));
          return true;
        }
        const last = latest.current.points.at(-1);
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) <= SAME_POINT) return true;
        const d = last ? directionOf(last, q) : null;
        setSteps((s) => [
          ...s,
          d !== null && last
            ? {
                kind: 'typed',
                dir: d,
                length: Math.hypot(q[0] - last[0], q[1] - last[1]),
                text: '',
              }
            : { kind: 'point', p: q },
        ]);
        return true;
      },
      move() {},
      up() {},
    });
    return () => {
      viewport.setPointerDelegate(null);
      viewport.setPreviewLines([]);
    };
  }, [viewport]);
  // The path so far, drawn in the view on the level.
  useEffect(() => {
    if (!viewport || points.length === 0) {
      viewport?.setPreviewLines([]);
      return;
    }
    const z = level ? levelElevation(level) : 0;
    const line = points.map((p) => [p[0], p[1], z] as [number, number, number]);
    if (closed && points.length >= 3) line.push(line[0]!);
    viewport.setPreviewLines([line]);
  }, [viewport, JSON.stringify(points), closed, level]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    const errs: Record<string, string> = {};
    if (!sx.ok) errs.startX = sx.message;
    if (!sy.ok) errs.startY = sy.message;
    if (!level) errs.form = 'Add a level first.';
    if (Object.keys(errs).length > 0 || !start || !level) {
      setErrors(errs);
      return;
    }
    const r = buildWall(documents.getState().document, partId, settings, {
      level: level.id,
      wallType,
      points,
      closed,
      others,
    });
    if (!r.ok) {
      setErrors({ form: r.message });
      return;
    }
    const done = documents.getState().execute(r.command, r.label);
    if (!done.ok) {
      setErrors({ form: done.error.message });
      return;
    }
    onClose();
  };

  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  const backOnStart =
    points.length >= 4 &&
    Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1]) <= SAME_POINT;
  const outline = backOnStart ? points.slice(0, -1) : points;
  const lengths =
    outline.length > 1
      ? segmentLengths(outline, (closed || backOnStart) && outline.length >= 3)
      : [];

  return (
    <aside
      className="selection-panel feature-dialog construction-tool"
      role="dialog"
      aria-label="Wall"
      data-testid="wall-tool"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Wall</h2>
      {types.length === 0 && (
        <p className="field-error" role="alert">
          Make a wall type first (Construction panel, Wall types).
        </p>
      )}
      <Select
        label="Level"
        name="wall-level"
        value={level?.id ?? ''}
        options={levels.map((l) => [l.id, l.name] as const)}
        onChange={(v) => ui.getState().setLevel(v)}
      />
      <Select
        label="Wall type"
        name="wall-type"
        value={wallType}
        options={types.map((t) => [t.id, t.name] as const)}
        onChange={setWallType}
      />
      <div className="construction-row">
        <Field
          label="Start X"
          testId="wall-start-x"
          value={startX}
          error={errors.startX}
          onChange={setStartX}
        />
        <Field
          label="Start Y"
          testId="wall-start-y"
          value={startY}
          error={errors.startY}
          onChange={setStartY}
        />
      </div>
      <p className="field-note">
        Or click points in the view: they snap to wall ends, square to the last point and to a grid.
      </p>
      <ol className="construction-steps" data-testid="wall-steps">
        {steps.map((s, i) => (
          <li key={i} data-testid={`wall-step-${i + 1}`}>
            {s.kind === 'typed'
              ? `${s.text !== '' ? s.text : fmt(s.length)} ${DIRECTION_LABELS[s.dir].toLowerCase()}`
              : `to (${fmt(s.p[0])}, ${fmt(s.p[1])})`}
          </li>
        ))}
      </ol>
      <div
        className="construction-row"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTyped();
          }
        }}
      >
        <Field
          label="Length"
          testId="wall-length"
          value={lengthText}
          error={errors.length}
          placeholder={units.length.unit === 'ft-in' ? `16'` : ''}
          onChange={setLengthText}
        />
        <Select
          label="Direction"
          name="wall-direction"
          value={String(dir)}
          options={DIRECTIONS.map((d) => [String(d), DIRECTION_LABELS[d]] as const)}
          onChange={(v) => setDir(Number(v) as Direction)}
        />
        <button type="button" data-testid="wall-length-add" onClick={addTyped}>
          Add length
        </button>
      </div>
      <div className="construction-row">
        <button
          type="button"
          data-testid="wall-step-undo"
          disabled={steps.length === 0}
          onClick={() => {
            // Emptying the path makes the next click in the view a new start point.
            if (steps.length <= 1) clickedStart.current = false;
            setSteps((s) => s.slice(0, -1));
          }}
        >
          Remove last
        </button>
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={closed || backOnStart}
            disabled={backOnStart}
            data-testid="wall-closed"
            onChange={(e) => setClosed(e.target.checked)}
          />
          Close the loop (a building outline)
        </label>
      </div>
      <p className="field-note" data-testid="wall-summary">
        {summary(points, lengths, closed || backOnStart, units)}
      </p>
      {errors.form && (
        <p className="field-error" role="alert" data-testid="wall-error">
          {errors.form}
        </p>
      )}
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          data-testid="wall-add"
          disabled={types.length === 0 || points.length < 2}
          onClick={add}
        >
          Add wall
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </aside>
  );
}

function levelElevation(level: { elevation: number }): number {
  return level.elevation;
}

function summary(
  points: readonly P2[],
  lengths: readonly number[],
  closed: boolean,
  units: DisplayUnits,
): string {
  if (points.length < 2) return 'Type the first length, or click the start and the next points.';
  const total = lengths.reduce((a, b) => a + b, 0);
  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  return `${lengths.length} segment${lengths.length === 1 ? '' : 's'}, ${fmt(total)} in all${closed ? ', closed' : ''}.`;
}
