// The "Source" link in the app's and the viewer's header (T7.3c, ADR 0006): the page that names
// the commit this build was made from and the source of every .wasm module it ships. It opens in
// a new tab so it never leaves a document or a view behind.
import { SOURCE_PAGE } from './offer';
import './sourceLink.css';

export function SourceLink() {
  return (
    <a
      className="source-link"
      href={`${import.meta.env.BASE_URL}${SOURCE_PAGE}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="source-link"
      title="Source code of this build (GPL-3.0-or-later), and of its WebAssembly modules"
    >
      Source
    </a>
  );
}
