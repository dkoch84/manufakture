// The open document in the page URL (`?doc=<id>`), so a reload opens it again.

export const DOC_PARAM = 'doc';

/** The document id the URL names, or null. */
export function docIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get(DOC_PARAM);
  return id && id.length > 0 ? id : null;
}

/** `href` naming document `id` (or none when null), other parameters kept. */
export function withDocId(href: string, id: string | null): string {
  const url = new URL(href);
  if (id === null) url.searchParams.delete(DOC_PARAM);
  else url.searchParams.set(DOC_PARAM, id);
  return url.toString();
}

/** Point the current history entry at document `id`, without a reload. */
export function showDocIdInUrl(id: string | null): void {
  if (typeof window === 'undefined') return;
  const next = withDocId(window.location.href, id);
  if (next !== window.location.href) window.history.replaceState(window.history.state, '', next);
}
