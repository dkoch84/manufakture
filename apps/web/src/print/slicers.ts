// What the Open in slicer help says, per slicer and platform (ADR 0012 decision 11). The hand-off
// is a download: a page with no server has no web address a slicer could fetch the file from, so
// there is no custom-scheme launch. The help says how to get the downloaded file into the slicer:
// from the browser's download list, by making the slicer the program for .3mf files, or by
// importing it in the slicer. Plain data and text: the panel renders it as React text, never as
// HTML.

import type { SlicerId } from '../state/viewSettings';

export type Platform = 'windows' | 'macos' | 'linux';

export const PLATFORMS: readonly { id: Platform; name: string }[] = [
  { id: 'windows', name: 'Windows' },
  { id: 'macos', name: 'macOS' },
  { id: 'linux', name: 'Linux' },
];

export interface SlicerInfo {
  id: SlicerId;
  name: string;
  /** What the slicer makes of the file's colours (io README, "3MF"). */
  colours: string;
}

export const SLICERS: readonly SlicerInfo[] = [
  {
    id: 'orcaslicer',
    name: 'OrcaSlicer',
    colours:
      'Each colour arrives on a filament slot of its own, in order; the slot keeps the filament colour set in OrcaSlicer.',
  },
  {
    id: 'bambustudio',
    name: 'Bambu Studio',
    colours:
      'Each colour arrives on a filament slot of its own, in order; the slot keeps the filament colour set in Bambu Studio.',
  },
  {
    id: 'prusaslicer',
    name: 'PrusaSlicer',
    colours:
      'PrusaSlicer reads the parts, their names and where they are, but not their colours: pick the extruder for each part yourself.',
  },
];

export function slicerInfo(id: SlicerId): SlicerInfo {
  return SLICERS.find((s) => s.id === id) ?? SLICERS[0]!;
}

/** The platform the browser runs on, as far as it says; Windows when it does not. */
export function detectPlatform(
  nav:
    | { userAgent?: string; platform?: string; userAgentData?: { platform?: string } }
    | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Platform {
  const text = `${nav?.userAgentData?.platform ?? ''} ${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  if (/mac/i.test(text) && !/iphone|ipad/i.test(text)) return 'macos';
  if (/linux|x11|cros/i.test(text) && !/android/i.test(text)) return 'linux';
  return 'windows';
}

/** How to make `slicer` the program that opens .3mf files on `platform`. */
export function defaultAppStep(slicer: string, platform: Platform): string {
  switch (platform) {
    case 'windows':
      return `To open .3mf files in ${slicer} from now on: in File Explorer, right-click a .3mf file, choose Open with, then Choose another app, pick ${slicer} and make it the one to always use. Until then Windows may open .3mf files in another program, such as 3D Viewer.`;
    case 'macos':
      return `To open .3mf files in ${slicer} from now on: select a .3mf file in Finder, choose File > Get Info, pick ${slicer} under Open with, and click Change All.`;
    case 'linux':
      return `To open .3mf files in ${slicer} from now on: in your file manager, right-click a .3mf file, choose Open With (or Properties, then Open With), pick ${slicer} and set it as the default.`;
  }
}

/** The steps of the help, in order. */
export function handoffSteps(fileName: string, slicer: SlicerId, platform: Platform): string[] {
  const name = slicerInfo(slicer).name;
  return [
    `Open ${fileName} from the browser's download list (its downloads button or bar). It opens in the program set for .3mf files.`,
    defaultAppStep(name, platform),
    `Or start ${name} and import the file with File > Import, or drag it from the download list onto the ${name} window.`,
  ];
}
