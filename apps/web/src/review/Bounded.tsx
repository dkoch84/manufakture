// Untrusted text and lists from a review bundle, shown bounded: text as React text only (never
// as HTML), with control and format characters shown as escapes (`visible`) in a bidi-isolated
// span, so a bidirectional override or a zero-width mark cannot change what a reviewer reads or
// the text around it, cut at a length with **Show all**, lists shown a page at a time with **Show more**,
// and anything that still throws while rendering caught, so a malformed bundle never takes the
// app down with it.

import { Component, useState, type ReactNode } from 'react';
import { text, visible } from './review';

/**
 * Text cut at `max` characters, with **Show all** to read the rest, its hidden characters shown
 * (`visible`).
 */
export function Clipped({
  value,
  max = 300,
  pre = false,
  testId,
}: {
  value: unknown;
  max?: number;
  /** Keep line breaks and spaces (code, JSON). */
  pre?: boolean;
  testId?: string;
}) {
  const [all, setAll] = useState(false);
  const s = text(value);
  const cut = !all && s.length > max;
  // Cut first, then escaped: a pair the cut splits shows as its lone half's escape.
  const shown = visible(cut ? s.slice(0, max) : s);
  // Isolated (`<bdi>`, and `unicode-bidi: isolate` in review.css): its direction never leaks out.
  const body = pre ? <pre className="review-pre">{shown}</pre> : <bdi>{shown}</bdi>;
  return (
    <span className="review-clipped" data-testid={testId}>
      {body}
      {cut && (
        <>
          {!pre && '...'}{' '}
          <button
            type="button"
            className="review-link"
            onClick={() => setAll(true)}
            title={`${s.length - max} more characters`}
          >
            Show all
          </button>
        </>
      )}
    </span>
  );
}

/** How many entries a list shows before **Show more**, and how many each press adds. */
export const PAGE = 50;

/**
 * A list shown `PAGE` entries at a time. `omitted`: entries the bundle itself left out, said at
 * the end.
 */
export function Paged<T>({
  items,
  omitted = 0,
  render,
  className = 'review-list',
  testId,
}: {
  items: readonly T[];
  omitted?: number;
  render: (item: T, index: number) => ReactNode;
  className?: string;
  testId?: string;
}) {
  const [shown, setShown] = useState(PAGE);
  const rest = items.length - shown;
  return (
    <>
      <ul className={className} data-testid={testId}>
        {items.slice(0, shown).map((item, i) => (
          <li key={i}>{render(item, i)}</li>
        ))}
      </ul>
      {rest > 0 && (
        <button type="button" className="review-link" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(rest, PAGE)} more of {rest}
        </button>
      )}
      {omitted > 0 && <p className="field-note">and {omitted} more left out of the bundle</p>}
    </>
  );
}

/** Catches a render error in a part of the bundle, and says which part could not be shown. */
export class Guarded extends Component<{ what: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <p className="history-error" role="alert">
          {this.props.what} of this bundle cannot be shown: it is not what this release reads.
        </p>
      );
    }
    return this.props.children;
  }
}
