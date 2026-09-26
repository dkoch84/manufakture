// Getting bytes out of and into the browser: downloads and file pickers.

export const MIME = {
  stl: 'model/stl',
  '3mf': 'model/3mf',
  step: 'model/step',
} as const;

/** Save bytes as a download named `fileName`. */
export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download has started from the URL; give it a moment before letting go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The bytes of a picked file. */
export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A byte count for messages: `512 B`, `12.3 KB`, `4.5 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
