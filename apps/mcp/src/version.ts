// The tool surface's version (ADR 0016 decision 7), reported as the MCP server info's version.
// The tool list is a public contract: add, never silently change. Raise the minor number on every
// addition (a tool, an optional input field, an output field) and rewrite tools.golden.json in the
// same change; the golden test checks both. A change that does more than add is a new tool under a
// new name, with the old one kept and marked deprecated in its description.

export const SERVER_NAME = 'manufakture';
export const SURFACE_VERSION = '1.1.0';
