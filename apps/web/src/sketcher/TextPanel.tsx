// The Text panel (M3 plan, T3.2d): edits the selected text of the sketch: its string, font
// (with Add font), size as an expression, alignment, spacing and angle. For SVG artwork (an
// outline with an `svg` source, M5 T5.8) it edits the scale and the angle instead. Changes go to the sketch
// session at once (typing in one field is one undo step) and the sketcher lays the text out
// again through the regen worker (`useTextPreviews`). The anchor is dragged and dimensioned in
// the sketch like a point.

import { MAX_OUTLINE_TEXT, bareUnits, codePointLength, type DocumentFont } from '@manufakture/core';
import type { OutlineEntity } from '@manufakture/sketch/model';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import { analyzeExpression, type ValueKind } from '../components/expression';
import { AddFont } from './AddFont';
import type { SketchSessionStore, TextPatch } from './session';
import {
  RECOMMENDED_MIN_SIZE_MM,
  fontLabel,
  type SvgOutline,
  type TextOutline,
  type Texter,
} from './text';
import { evaluateStored, measuredSource } from './values';

export interface TextPanelProps {
  session: SketchSessionStore;
  /** Reads fonts for Add font; without it fonts cannot be added (no geometry worker). */
  texter: Texter | null;
}

/** The text the selection names: a text entity, or a text's anchor. */
function selectedText(session: SketchSessionStore): OutlineEntity | null {
  const { selection, sketch } = session.getState();
  if (selection.length !== 1) return null;
  const item = selection[0]!;
  const id = item.kind === 'entity' ? item.id : item.kind === 'point' ? item.ref.entity : null;
  const e = sketch.entities.find((x) => x.id === id);
  return e?.kind === 'outline' ? e : null;
}

export function TextPanel({ session, texter }: TextPanelProps) {
  // Re-render on the session's changes that matter here.
  useStore(session, (s) => s.selection);
  useStore(session, (s) => s.sketch.entities);
  const text = selectedText(session);
  if (!text) return null;
  if (text.source.kind === 'svg') return <SvgFields key={text.id} session={session} id={text.id} />;
  return <TextFields key={text.id} session={session} texter={texter} id={text.id} />;
}

/** Warnings an SVG artwork's panel lists; past this it says how many more there are. */
const MAX_SHOWN_WARNINGS = 8;

const ALIGN_H = [
  ['left', 'Left'],
  ['center', 'Centre'],
  ['right', 'Right'],
] as const;
const ALIGN_V = [
  ['baseline', 'Baseline'],
  ['middle', 'Middle'],
  ['top', 'Top'],
] as const;

type Field = 'size' | 'letterSpacing' | 'lineSpacing' | 'angle';

function TextFields({ session, texter, id }: TextPanelProps & { id: string }) {
  const found = useStore(session, (s) => s.sketch.entities.find((e) => e.id === id));
  const entity =
    found?.kind === 'outline' && found.source.kind === 'text' ? (found as TextOutline) : undefined;
  const fonts = useStore(session, (s) => s.fonts);
  const preview = useStore(session, (s) => s.texts[id]);
  const placed = useStore(session, (s) => s.placedText === id);
  const source = useStore(session, (s) => s.source);
  // What the user is typing in a numeric field that does not evaluate yet (or has not been
  // committed); the stored value shows otherwise.
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  const [adding, setAdding] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!placed || !textArea.current) return;
    textArea.current.focus();
    textArea.current.select();
  }, [placed]);

  if (!entity || !source) return null;
  const { units, variables } = source;
  const names = Object.keys(variables);
  const update = (patch: TextPatch, coalesce?: string) =>
    session.getState().updateText(id, patch, coalesce ? { coalesce } : {});
  const stored: Record<Field, string> = {
    size: entity.source.size.source,
    letterSpacing: entity.source.letterSpacing?.source ?? '',
    lineSpacing: entity.source.lineSpacing?.source ?? '',
    angle: measuredSource(entity.angle, 'angle', units),
  };
  const shown = (f: Field) => drafts[f] ?? stored[f];
  const kinds: Record<Field, ValueKind> = {
    size: 'length',
    letterSpacing: 'length',
    lineSpacing: 'number',
    angle: 'angle',
  };
  const validate: Partial<Record<Field, (v: number) => string | null>> = {
    size: (v) => (v > 0 ? null : 'The size must be above 0.'),
    lineSpacing: (v) => (v > 0 ? null : 'The line spacing must be above 0.'),
  };
  const change = (f: Field, value: string) => {
    setDrafts((d) => ({ ...d, [f]: value }));
    const a = analyzeExpression(value, kinds[f], units, variables, validate[f]);
    if (a.state === 'empty' && (f === 'letterSpacing' || f === 'lineSpacing')) {
      update({ [f]: null }, f);
      return;
    }
    if (a.state !== 'ok') return;
    if (f === 'angle') update({ angle: a.value }, f);
    else update({ [f]: a.expression }, f);
  };
  const settle = (f: Field) =>
    setDrafts((d) => {
      const { [f]: _gone, ...rest } = d;
      void _gone;
      return rest;
    });
  const numeric = (f: Field, label: string, testId: string, placeholder?: string) => (
    <div className="text-field" key={f}>
      <ExpressionField
        label={label}
        value={shown(f)}
        kind={kinds[f]}
        units={units}
        variables={variables}
        names={names}
        validate={validate[f]}
        testId={testId}
        errorTestId={`${testId}-error`}
        onChange={(v) => change(f, v)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
        }}
        onBlur={(_, a) => {
          // A value that evaluates is settled: the field shows the stored one. One that does not
          // is kept as the draft and shown red with its error, so the user can fix it.
          if (a.state === 'ok' || a.state === 'empty') settle(f);
        }}
      />
      {placeholder && shown(f) === '' && <p className="field-note">{placeholder}</p>}
    </div>
  );

  const font = fonts.find((f) => f.id === entity.source.font);
  const size = evaluateStored(entity.source.size, 'length', variables);
  const small =
    font?.source.kind === 'bundled' && size !== null && size > 0 && size < RECOMMENDED_MIN_SIZE_MM;
  const length = codePointLength(entity.source.text);

  return (
    <section
      className="text-panel"
      aria-label="Text"
      data-testid="text-panel"
      data-entity={id}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <h2>Text {id}</h2>
      <label className="text-field">
        <span>Text</span>
        <textarea
          ref={textArea}
          rows={2}
          value={entity.source.text}
          data-testid="text-string"
          spellCheck={false}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (codePointLength(value) > MAX_OUTLINE_TEXT) return;
            update({ text: value }, 'text');
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      </label>
      {length === 0 && <p className="field-note">An empty text makes no letters.</p>}
      {length > MAX_OUTLINE_TEXT * 0.9 && (
        <p className="field-note">
          {length} of at most {MAX_OUTLINE_TEXT} characters.
        </p>
      )}
      <div className="text-field">
        <label>
          <span>Font</span>
          <select
            value={entity.source.font}
            data-testid="text-font"
            onChange={(e) => update({ font: e.currentTarget.value })}
          >
            {!font && <option value={entity.source.font}>{entity.source.font} (missing)</option>}
            {fonts.map((f: DocumentFont) => (
              <option key={f.id} value={f.id}>
                {fontLabel(f)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="text-add-font"
          disabled={!texter || adding}
          title={
            texter
              ? 'Add a TrueType or OpenType font file to the document'
              : 'Fonts can be added once the geometry kernel has loaded'
          }
          onClick={() => setAdding(true)}
        >
          Add font...
        </button>
      </div>
      {adding && texter && (
        <AddFont
          texter={texter}
          fonts={fonts}
          nextId={session.getState().nextFontId()}
          onCancel={() => setAdding(false)}
          onAdd={(f) => {
            const added = 'id' in f ? f : session.getState().addFont(f);
            setAdding(false);
            update({ font: added.id });
          }}
        />
      )}
      {numeric('size', 'Size (cap height)', 'text-size')}
      {small && (
        <p className="text-warning" data-testid="text-small">
          Below {RECOMMENDED_MIN_SIZE_MM} mm the strokes of {font!.family} {font!.style} are thinner
          than two line widths at a 0.4 mm nozzle and may not print cleanly. Check the part with the
          print checks.
        </p>
      )}
      <div className="text-field text-align">
        <label>
          <span>Horizontal</span>
          <select
            value={entity.source.align.horizontal}
            data-testid="text-align-h"
            onChange={(e) =>
              update({
                align: {
                  ...entity.source.align,
                  horizontal: e.currentTarget.value as TextOutline['source']['align']['horizontal'],
                },
              })
            }
          >
            {ALIGN_H.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Vertical</span>
          <select
            value={entity.source.align.vertical}
            data-testid="text-align-v"
            onChange={(e) =>
              update({
                align: {
                  ...entity.source.align,
                  vertical: e.currentTarget.value as TextOutline['source']['align']['vertical'],
                },
              })
            }
          >
            {ALIGN_V.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {numeric('letterSpacing', 'Letter spacing', 'text-letter-spacing', "None: the font's own.")}
      {numeric(
        'lineSpacing',
        'Line spacing (times the line height)',
        'text-line-spacing',
        "The font's line height.",
      )}
      {numeric('angle', `Angle (${bareUnits(units).angleUnit})`, 'text-angle')}
      {preview?.error && (
        <p className="text-error" role="alert" data-testid="text-error">
          {preview.error}
        </p>
      )}
      {preview?.warnings.map((w, i) => (
        <p key={i} className="text-warning" data-testid="text-warning">
          {w}
        </p>
      ))}
      <p className="field-note">
        Drag the text, or dimension its anchor like a point. Emboss or deboss it with Extrude: pick
        the text regions with Text only.
      </p>
    </section>
  );
}

type SvgField = 'scale' | 'angle';

/** SVG artwork: its file, its scale (a plain number, an expression) and its angle. */
function SvgFields({ session, id }: { session: SketchSessionStore; id: string }) {
  const found = useStore(session, (s) => s.sketch.entities.find((e) => e.id === id));
  const preview = useStore(session, (s) => s.texts[id]);
  const source = useStore(session, (s) => s.source);
  const [drafts, setDrafts] = useState<Partial<Record<SvgField, string>>>({});
  if (found?.kind !== 'outline' || found.source.kind !== 'svg' || !source) return null;
  const entity = found as SvgOutline;
  const { units, variables } = source;
  const names = Object.keys(variables);
  const stored: Record<SvgField, string> = {
    scale: entity.source.scale?.source ?? '1',
    angle: measuredSource(entity.angle, 'angle', units),
  };
  const kinds: Record<SvgField, ValueKind> = { scale: 'number', angle: 'angle' };
  const validate: Partial<Record<SvgField, (v: number) => string | null>> = {
    scale: (v) => (v > 0 ? null : 'The scale must be above 0.'),
  };
  const update = (patch: TextPatch, coalesce: string) =>
    session.getState().updateText(id, patch, { coalesce });
  const change = (f: SvgField, value: string) => {
    setDrafts((d) => ({ ...d, [f]: value }));
    const a = analyzeExpression(value, kinds[f], units, variables, validate[f]);
    if (a.state === 'empty' && f === 'scale') {
      update({ scale: null }, f);
      return;
    }
    if (a.state !== 'ok') return;
    if (f === 'angle') update({ angle: a.value }, f);
    else update({ scale: a.expression }, f);
  };
  const field = (f: SvgField, label: string, testId: string) => (
    <div className="text-field" key={f}>
      <ExpressionField
        label={label}
        value={drafts[f] ?? stored[f]}
        kind={kinds[f]}
        units={units}
        variables={variables}
        names={names}
        validate={validate[f]}
        testId={testId}
        errorTestId={`${testId}-error`}
        onChange={(v) => change(f, v)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
        }}
        onBlur={(_, a) => {
          if (a.state === 'ok' || a.state === 'empty')
            setDrafts((d) => {
              const { [f]: _gone, ...rest } = d;
              void _gone;
              return rest;
            });
        }}
      />
    </div>
  );
  const shapes = entity.source.paths.length;
  return (
    <section
      className="text-panel"
      aria-label="SVG artwork"
      data-testid="svg-outline-panel"
      data-entity={id}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <h2>SVG artwork {id}</h2>
      <p data-testid="svg-outline-file">
        {entity.source.fileName}: {shapes} shape{shapes === 1 ? '' : 's'}
      </p>
      {field('scale', 'Scale', 'svg-outline-scale')}
      {field('angle', `Angle (${bareUnits(units).angleUnit})`, 'svg-outline-angle')}
      {preview?.error && (
        <p className="text-error" role="alert" data-testid="svg-outline-error">
          {preview.error}
        </p>
      )}
      {preview?.warnings.slice(0, MAX_SHOWN_WARNINGS).map((w, i) => (
        <p key={i} className="text-warning">
          {w}
        </p>
      ))}
      {preview && preview.warnings.length > MAX_SHOWN_WARNINGS && (
        <p className="text-warning" data-testid="svg-outline-more-warnings">
          And {(preview.warnings.length - MAX_SHOWN_WARNINGS).toLocaleString('en')} more.
        </p>
      )}
      <p className="field-note">
        Drag the artwork, or dimension its anchor like a point. Its shapes are not sketch lines:
        pocket, V-carve or extrude them as regions.
      </p>
    </section>
  );
}
