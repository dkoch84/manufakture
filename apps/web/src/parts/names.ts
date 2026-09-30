/** The id of the element the part studio tabs control: the editor area showing the active one. */
export const PART_STUDIO_PANEL_ID = 'part-studio-panel';

/** The name a new part studio gets: "Part n", after its id `part#n`. */
export function newPartName(partId: string): string {
  const n = /#(\d+)$/.exec(partId)?.[1];
  return n ? `Part ${n}` : 'Part';
}
