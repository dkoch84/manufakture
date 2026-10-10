import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { DISCLAIMER_SHORT, createMechEvaluation, mechSettings } from '@manufakture/domain-mech';
import type { DomainEvaluationResult } from '@manufakture/regen';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createModelStore } from '../../model/model';
import { ChecksPanel, MechChecksButton } from './ChecksPanel';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

/** A rope with a static load case (890 N) and a dynamic one, and a strength factor of 2. */
function design(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'd', name: 'Trainer' }),
    {
      type: 'setDomainData',
      namespace: 'mech',
      schemaVersion: 1,
      data: { factors: { strength: 2 } } as never,
    },
    {
      type: 'setCatalogEntry',
      entry: {
        id: 'entry#1',
        version: 1,
        family: 'rope',
        fieldsVersion: 1,
        maker: 'Acme',
        partNumber: 'HMPE 3 mm',
        description: '',
        ratings: { minimumBreakingLoad: { value: 4500 } },
        sources: [],
        verified: false,
      },
    },
    {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#2',
        entry: { source: 'document', id: 'entry#1' },
        alternates: [],
        name: 'Rope',
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#3',
        name: 'Hold',
        static: [{ kind: 'cable', name: 'Max pull', force: x('890 N'), angle: x('0 deg') }],
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#4',
        name: 'Rep',
        dynamic: {
          mode: { kind: 'constant' },
          force: x('400 N'),
          motion: {
            kind: 'half-cosine',
            stroke: x('1 m'),
            pullSpeed: x('1 m/s'),
            returnSpeed: x('1 m/s'),
            pause: x('0.5 s'),
          },
          reps: x('10'),
        },
      },
    },
  );
}

/** A model store holding what the evaluation stage gives for `design()`. */
function modelWithChecks() {
  const doc = design();
  const settings = mechSettings(doc.domains);
  if (!settings.ok) throw new Error(settings.message);
  const out = createMechEvaluation({ implementation: 1 }).evaluate(
    {
      document: doc,
      data: { mech: settings.value },
      variables: new Map(),
      parts: [],
      assemblies: [],
    },
    [],
  );
  const evaluation: DomainEvaluationResult = {
    namespace: 'mech',
    ...(out.data === undefined ? {} : { data: out.data }),
    warnings: [...(out.warnings ?? [])],
    ms: 1,
  };
  const model = createModelStore();
  model.setState({ evaluations: [evaluation] });
  return model;
}

const WORDS = /\b(safe|pass(es|ed|ing)?|fail(s|ed|ing|ure)?|certif\w*|complian\w*|ok)\b/i;

describe('the checks panel', () => {
  it('lists every record with its line and status, and the notice', () => {
    const model = modelWithChecks();
    render(<ChecksPanel model={model} onClose={() => {}} />);
    expect(screen.getByTestId('checks-disclaimer').textContent).toBe(DISCLAIMER_SHORT);
    const hold = screen.getByTestId('checks-record-cable.tension@pp#2/lc#3');
    expect(hold.textContent).toContain(
      'Cable tension, Rope in Hold: load 890 N, rated load 4.50 kN; factor 5.06, above your 2',
    );
    expect(screen.getByTestId('checks-status-cable.tension@pp#2/lc#3').textContent).toBe(
      'above your factor',
    );
    expect(screen.getByTestId('checks-status-cable.tension@pp#2/lc#4').textContent).toBe(
      'not computed',
    );
    // Everything said here, apart from the notice, is numbers and margins.
    const panel = screen.getByTestId('checks-records');
    expect(panel.textContent).not.toMatch(WORDS);
  });

  it('shows a record’s working on request, and names the missing input of an unknown one', () => {
    render(<ChecksPanel model={modelWithChecks()} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('checks-toggle-cable.tension@pp#2/lc#3'));
    const working = screen.getByTestId('checks-working-cable.tension@pp#2/lc#3');
    expect(working.textContent).toContain('n = F_rated / F');
    expect(working.textContent).toContain('load case Hold (lc#3), cable pull "Max pull"');
    expect(working.textContent).toContain('your factor, setting factors.strength');
    expect(working.textContent).toMatch(/margin 152\.\d %/);
    expect(working.textContent).toContain('Shigley');

    fireEvent.click(screen.getByTestId('checks-toggle-cable.tension@pp#2/lc#4'));
    expect(screen.getByTestId('checks-missing-cable.tension@pp#2/lc#4').textContent).toBe(
      'Missing: Peak cable tension',
    );
    expect(screen.getByTestId('checks-working-cable.tension@pp#2/lc#4').textContent).toContain(
      'no simulation of lc#4 has run',
    );
    fireEvent.click(screen.getByTestId('checks-toggle-cable.tension@pp#2/lc#3'));
    expect(screen.queryByTestId('checks-working-cable.tension@pp#2/lc#3')).toBeNull();
  });

  it('says when no check applies, and opens from the toolbar with a count to look at', () => {
    const empty = createModelStore();
    const { unmount } = render(<ChecksPanel model={empty} onClose={() => {}} />);
    expect(screen.getByTestId('checks-empty')).toBeTruthy();
    unmount();
    render(<MechChecksButton model={modelWithChecks()} disabled={false} />);
    expect(screen.getByTestId('checks-open').textContent).toBe('Checks (1)');
    fireEvent.click(screen.getByTestId('checks-open'));
    expect(screen.getByTestId('checks-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('checks-close'));
    expect(screen.queryByTestId('checks-panel')).toBeNull();
  });

  it('shows an evaluation that could not run as an error', () => {
    const model = createModelStore();
    model.setState({
      evaluations: [
        {
          namespace: 'mech',
          warnings: [],
          ms: 0,
          error: { code: 'extension', message: 'The "mech" evaluation failed: boom' },
        },
      ],
    });
    render(<ChecksPanel model={model} onClose={() => {}} />);
    expect(screen.getByTestId('checks-error').textContent).toMatch(/boom/);
  });
});
