// Test and tooling surfaces: the `window.__manufakture` hook and the
// kernel-free `?scene=test` and `?scene=perf` scenes. On in development (and
// in unit tests), off in a production build unless it is built with
// VITE_E2E=1, as the Playwright run does (see playwright.config.ts).

export const testHooksEnabled: boolean = import.meta.env.DEV || import.meta.env.VITE_E2E === '1';
