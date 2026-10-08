// What every fabrication export returns (M8 plan T8.1b, cross-cutting decision 5): a file to save,
// with its name and media type, the same shape whether the app downloads it or a headless session
// writes it to disk. The entry points that make them are listed in README.md, "Fabrication
// exports".

/** One exported file. */
export interface FabricationFile {
  /** The file name, extension included. */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Its media type (`FABRICATION_MIME`). */
  readonly type: string;
}

/** The media types of the fabrication formats. */
export const FABRICATION_MIME = {
  csv: 'text/csv',
  pdf: 'application/pdf',
  dxf: 'application/dxf',
  svg: 'image/svg+xml',
  stl: 'model/stl',
  '3mf': 'model/3mf',
  step: 'model/step',
  gcode: 'text/plain',
  html: 'text/html',
  zip: 'application/zip',
} as const;

/**
 * A file named after a document: `Bookshelf cut list.csv`, `Shed takeoff.pdf`. Characters file
 * systems refuse become spaces; a name of nothing else becomes `manufakture`.
 */
export function documentFileName(documentName: string, what: string, extension: string): string {
  const base = documentName.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'manufakture';
  return `${base} ${what}.${extension}`;
}
