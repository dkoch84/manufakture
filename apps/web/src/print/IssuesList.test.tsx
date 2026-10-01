// The Issues list: one row per issue with its worst value; a click frames it, a second lets go.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_ANALYSIS, type AnalysisState } from './analysis';
import { IssuesList } from './IssuesList';
import type { PrintIssue } from './issues';

afterEach(cleanup);

const ISSUES: PrintIssue[] = [
  {
    key: 'overhang:item#1',
    kind: 'overhang',
    itemId: 'item#1',
    item: 'T',
    worst: '90.00°',
    detail: '300.0 mm² steeper than 60.00° from vertical.',
    targets: [],
  },
  {
    key: 'thinWall:item#2',
    kind: 'thinWall',
    itemId: 'item#2',
    item: 'Fin',
    worst: '0.50 mm',
    detail: '200.0 mm² thinner than two lines (0.84 mm).',
    targets: [],
  },
];

const DONE: AnalysisState = {
  running: false,
  reply: { bodies: [], issues: [], meshes: [] },
  ms: 1,
  message: null,
};

describe('IssuesList', () => {
  it('lists each issue with its title, worst value and item', () => {
    render(<IssuesList issues={ISSUES} focus={null} analysis={DONE} checking onPick={vi.fn()} />);
    const thin = screen.getByTestId('print-issue-thinWall');
    expect(thin.textContent).toContain('Thin wall0.50 mmFin: 200.0 mm² thinner than two lines');
    expect(thin.getAttribute('data-worst')).toBe('0.50 mm');
    expect(screen.getByTestId('print-issue-overhang').textContent).toContain('Overhang90.00°T:');
  });

  it('frames an issue on a click and lets go on a second one', () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <IssuesList issues={ISSUES} focus={null} analysis={DONE} checking onPick={onPick} />,
    );
    fireEvent.click(screen.getByTestId('print-issue-overhang'));
    expect(onPick).toHaveBeenLastCalledWith(ISSUES[0]);
    rerender(
      <IssuesList
        issues={ISSUES}
        focus="overhang:item#1"
        analysis={DONE}
        checking
        onPick={onPick}
      />,
    );
    expect(screen.getByTestId('print-issue-overhang').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('print-issue-overhang'));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it('says what it found, while checking, when done, and when the worker failed', () => {
    const { rerender } = render(
      <IssuesList
        issues={[]}
        focus={null}
        analysis={{ ...IDLE_ANALYSIS, running: true }}
        checking
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('print-analysis-running')).toBeTruthy();
    expect(screen.getByTestId('print-no-issues').textContent).toContain('No issues found so far.');
    rerender(<IssuesList issues={[]} focus={null} analysis={DONE} checking onPick={vi.fn()} />);
    expect(screen.getByTestId('print-no-issues').textContent).toContain(
      'Nothing found that may print badly.',
    );
    rerender(
      <IssuesList
        issues={[]}
        focus={null}
        analysis={{ ...IDLE_ANALYSIS, message: 'bad mesh' }}
        checking
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('print-analysis-failed').textContent).toContain('bad mesh');
    rerender(
      <IssuesList issues={[]} focus={null} analysis={DONE} checking={false} onPick={vi.fn()} />,
    );
    expect(screen.getByText('Nothing to check yet.')).toBeTruthy();
  });
});
