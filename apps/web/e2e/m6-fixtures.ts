import {
  HOUSE_IDS,
  MOVED_POSITION_IN,
  houseCommands,
  movedWindow,
} from '@manufakture/domain-construction/fixtures/house';
import type { Page } from '@playwright/test';

// M6 fixtures for the e2e specs: the T6.5d house (packages/domain-construction/src/fixtures/
// house.ts, the same document the Node bench and the domain's tests build), as document commands
// for the app's store, and what it should show.

export { HOUSE_IDS, MOVED_POSITION_IN };

/** What the house builds (the domain's `src/fixtures/house.test.ts` checks the same in Node). */
export const HOUSE = {
  members: 794,
  /** A member group per wall (with its openings), per floor and for the roof. */
  groups: 14,
  /** Two layers per wall (11 walls), a subfloor per floor (2), four roof planes. */
  bodies: 28,
  features: 24,
} as const;

/**
 * Every layer id of the house's bodies (`<feature id>:layer/<layer id>`): hiding them all leaves
 * the framing alone in the view.
 */
export const HOUSE_LAYERS = [
  'sheathing',
  'drywall',
  'drywall-a',
  'drywall-b',
  'subfloor',
  'sheathing-e1',
  'sheathing-e2',
  'sheathing-e3',
  'sheathing-e4',
];

/** The batch that builds the house in the active part (one undo step). */
export async function houseBatch(page: Page): Promise<unknown> {
  const partId = await page.evaluate(() => window.__manufakture!.document.getState().activePartId);
  return houseCommands(partId);
}

/** The edit that moves the house's south-wall window to `position` inches. */
export async function moveWindow(page: Page, position: number): Promise<unknown> {
  const partId = await page.evaluate(() => window.__manufakture!.document.getState().activePartId);
  return { type: 'editFeature', partId, feature: movedWindow(position) };
}
