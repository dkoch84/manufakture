// Which bodies the Export menu writes, apart from the menu itself (a component module exports
// only components).

/** A body the menu offers: its viewport id, its name, and whether it is hidden in the view. */
export interface ExportableBody {
  id: string;
  name: string;
  hidden: boolean;
}

/**
 * The bodies an export writes: each one's tick (`ticks`, the ones the user changed while the
 * menu is open), or, untouched, whether it is shown. So a hidden body is not written unless
 * ticked, and hiding or showing one with the menu open changes its tick at once.
 */
export function chosenBodies(
  bodies: readonly ExportableBody[],
  ticks: ReadonlyMap<string, boolean>,
): string[] {
  return bodies.filter((b) => ticks.get(b.id) ?? !b.hidden).map((b) => b.id);
}
