// One render of a review bundle. The bundle names its images by SHA-256 (`ImageRef`); the bytes
// are a blob of the document. Before anything is shown the reference is checked (a SHA-256, a
// size within the bundle's limit, sane dimensions), then the bytes: their size and SHA-256 must
// be the reference's, they must be a PNG, and its header must give the reference's width and
// height (image.ts). Only then are they shown, through a `blob:` URL of type image/png that is
// revoked when the image goes; never as HTML, never from a URL the bundle could choose.

import { useEffect, useState } from 'react';
import { checkedRef, imageProblem } from './image';
import { text } from './review';

type Shown = { kind: 'error'; message: string } | { kind: 'ok'; url: string };

export function ReviewImage({
  value,
  alt,
  read,
  missing,
  testId,
}: {
  /** The bundle's image reference (untrusted), or null. */
  value: unknown;
  alt: string;
  /** Reads the bytes stored under a SHA-256 (the library checks them too). */
  read: (sha256: string) => Promise<Uint8Array | null>;
  /** Why there is no image, as the bundle says (untrusted text). */
  missing?: unknown;
  testId?: string;
}) {
  const ref = checkedRef(value);
  // Everything the reference says, as one key: the effect reads the image again when it changes.
  const key = ref === null ? null : `${ref.sha256}/${ref.bytes}/${ref.width}/${ref.height}`;
  const [loaded, setLoaded] = useState<{ key: string; shown: Shown } | null>(null);

  useEffect(() => {
    if (key === null) return undefined;
    const [sha256, bytes, width, height] = key.split('/') as [string, string, string, string];
    const want = { sha256, bytes: Number(bytes), width: Number(width), height: Number(height) };
    let url: string | null = null;
    let cancelled = false;
    const show = (shown: Shown) => {
      if (!cancelled) setLoaded({ key, shown });
    };
    void (async () => {
      try {
        const stored = await read(want.sha256);
        if (stored === null)
          return show({ kind: 'error', message: 'The image is not stored here.' });
        const problem = await imageProblem(stored, want);
        if (problem) return show({ kind: 'error', message: problem });
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([stored.slice()], { type: 'image/png' }));
        show({ kind: 'ok', url });
      } catch (e) {
        show({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [key, read]);
  const shown = loaded !== null && loaded.key === key ? loaded.shown : null;

  if (value === null || value === undefined) {
    return (
      <div className="review-image review-image-missing" data-testid={testId} data-state="missing">
        {text(missing) ? text(missing).slice(0, 300) : 'No image.'}
      </div>
    );
  }
  if (ref === null) {
    return (
      <div className="review-image review-image-missing" data-testid={testId} data-state="invalid">
        The bundle names this image in a way this release does not read.
      </div>
    );
  }
  if (shown?.kind === 'ok') {
    return (
      <img
        className="review-image"
        data-testid={testId}
        data-state="ok"
        src={shown.url}
        alt={alt}
        width={ref.width}
        height={ref.height}
      />
    );
  }
  return (
    <div
      className="review-image review-image-missing"
      data-testid={testId}
      data-state={shown?.kind ?? 'loading'}
      role={shown?.kind === 'error' ? 'alert' : undefined}
    >
      {shown?.kind === 'error' ? shown.message : 'Reading the image...'}
    </div>
  );
}
