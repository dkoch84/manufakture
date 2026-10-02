// Add font (ADR 0011 decision 7): choose a TTF or OTF file, see what it is and what its license
// allows, and add it to the document with the sketch.
//
// The file is untrusted. This component checks only its name, size and first four bytes
// (`checkFontFile`) before handing the bytes to the regen worker's text worker, which parses it
// under the watchdog (`Texter.readFont`); nothing here parses it. Every string read from the font
// (names, copyright, license, URL) is rendered as plain React text: never as markup, and the
// license URL is not made a link.

import { sha256Hex, toBase64 } from '@manufakture/io';
import type { DocumentFont } from '@manufakture/core';
import type { FontSummary } from '@manufakture/regen';
import { useEffect, useRef, useState } from 'react';
import {
  checkFontFile,
  documentFont,
  embeddingLabel,
  fontLabel,
  fontTotalProblem,
  type Texter,
} from './text';

type Step =
  | { kind: 'choose' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'failed'; message: string }
  | {
      kind: 'read';
      fileName: string;
      bytes: Uint8Array;
      info: FontSummary;
      twin: DocumentFont | null;
    };

export interface AddFontProps {
  texter: Texter;
  /** The sketch's fonts, to find a file that is already in the document. */
  fonts: readonly DocumentFont[];
  /** The id the font will get, for the summary. */
  nextId: string;
  /** Add the font (or use the copy already there); the dialog closes. */
  onAdd: (font: Omit<DocumentFont, 'id'> | DocumentFont) => void;
  onCancel: () => void;
}

const kib = (n: number) =>
  n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function AddFont({ texter, fonts, nextId, onAdd, onCancel }: AddFontProps) {
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Each file chosen gets a number: a reply for an earlier choice is ignored.
  const pick = useRef(0);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const mine = ++pick.current;
    const current = () => alive.current && pick.current === mine;
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!current()) return;
    const problem = checkFontFile(file.name, file.size, head);
    if (problem) {
      setStep({ kind: 'failed', message: problem });
      return;
    }
    setStep({ kind: 'reading', fileName: file.name });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!current()) return;
    let reply;
    try {
      reply = await texter.readFont(file.name, bytes);
    } catch (error) {
      reply = {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!current()) return;
    if (reply === null) {
      setStep({
        kind: 'failed',
        message: 'The font could not be read: the geometry worker stopped. Try again.',
      });
      return;
    }
    if (!reply.ok) {
      setStep({ kind: 'failed', message: reply.message });
      return;
    }
    const twin = fonts.find((f) => f.source.sha256 === reply.info.sha256) ?? null;
    // A copy already in the document adds nothing; a new font must fit the document's total.
    const tooBig = twin ? null : fontTotalProblem(fonts, bytes.length);
    if (tooBig) {
      setStep({ kind: 'failed', message: tooBig });
      return;
    }
    setStep({ kind: 'read', fileName: file.name, bytes, info: reply.info, twin });
  };

  const add = async () => {
    if (step.kind !== 'read') return;
    if (step.twin) {
      onAdd(step.twin);
      return;
    }
    const tooBig = fontTotalProblem(fonts, step.bytes.length);
    if (tooBig) {
      setStep({ kind: 'failed', message: tooBig });
      return;
    }
    setBusy(true);
    try {
      // The document records the SHA-256 of the bytes it stores, computed here from them.
      const sha256 = await sha256Hex(step.bytes);
      if (sha256 !== step.info.sha256) {
        setStep({
          kind: 'failed',
          message: 'The file changed while it was read. Choose it again.',
        });
        return;
      }
      const { id, ...font } = documentFont(
        nextId,
        step.info,
        step.fileName,
        step.bytes,
        sha256,
        toBase64,
      );
      void id;
      onAdd(font);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div
      className="add-font"
      role="dialog"
      aria-label="Add font"
      data-testid="add-font"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h4>Add font</h4>
      <p className="field-note">
        A TrueType (.ttf) or OpenType (.otf) file. It is stored in this document, so the text looks
        the same wherever the document opens.
      </p>
      <input
        ref={input}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        aria-label="Font file"
        data-testid="add-font-file"
        onChange={(e) => void choose(e.currentTarget.files?.[0])}
      />
      {step.kind === 'reading' && <p data-testid="add-font-reading">Reading {step.fileName}...</p>}
      {step.kind === 'failed' && (
        <p className="text-error" role="alert" data-testid="add-font-error">
          {step.message}
        </p>
      )}
      {step.kind === 'read' && <FontSummaryView info={step.info} fileName={step.fileName} />}
      {step.kind === 'read' && step.twin && (
        <p className="field-note" data-testid="add-font-twin">
          This file is already in the document as {fontLabel(step.twin)}.
        </p>
      )}
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          disabled={step.kind !== 'read' || busy}
          data-testid="add-font-ok"
          onClick={() => void add()}
        >
          {step.kind === 'read' && step.twin ? 'Use it' : 'Add font'}
        </button>
        <button type="button" data-testid="add-font-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What the font says about itself, as plain text. */
export function FontSummaryView({ info, fileName }: { info: FontSummary; fileName: string }) {
  const rows: [string, string, string][] = [
    ['Family', info.family, 'family'],
    ['Style', info.style, 'style'],
  ];
  if (info.version) rows.push(['Version', info.version, 'version']);
  if (info.copyright) rows.push(['Copyright', info.copyright, 'copyright']);
  if (info.license) rows.push(['License', info.license, 'license']);
  if (info.licenseUrl) rows.push(['License URL', info.licenseUrl, 'license-url']);
  rows.push(['Embedding', embeddingLabel(info.embedding), 'embedding']);
  rows.push(['File', `${fileName}, ${kib(info.size)}`, 'file']);
  return (
    <div className="font-summary" data-testid="font-summary">
      <dl>
        {rows.map(([label, value, id]) => (
          <div key={id} className="font-row">
            <dt>{label}</dt>
            <dd data-testid={`font-${id}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {info.embedding.restrictive && (
        <p className="text-warning" role="note" data-testid="font-restrictive">
          This font&apos;s embedding permissions are restrictive. Storing it in a document that you
          share may not be allowed by its license; check the license before sharing the document.
        </p>
      )}
      {info.embedding.bitmapOnly && (
        <p className="text-warning" role="note">
          The font allows only its bitmaps to be embedded, but text is made from its outlines.
        </p>
      )}
      {info.variable && (
        <p className="field-note">A variable font: its default instance is used.</p>
      )}
      <p className="field-note">
        The font is yours to use under its own license; manufakture only stores it in the document
        and never shares it on its own. Mesh and CAD exports hold geometry only.
      </p>
    </div>
  );
}
