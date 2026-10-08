// Stands in for `@playwright/test` when the app's e2e fixture modules are imported in Node (see
// vitest.config.ts). Only their pure command builders are used; anything that drives a page fails.

const unavailable = (): never => {
  throw new Error('@playwright/test is stubbed in this spike');
};

export const expect = Object.assign(unavailable, { poll: unavailable, soft: unavailable });
export const test = Object.assign(unavailable, { describe: unavailable, beforeAll: unavailable });
export type Page = never;
