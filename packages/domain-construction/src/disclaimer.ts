// The short "not an engineering tool" text (M6 plan, Part 2, decision 11; ADR 0015 decision 8).
// One string for the app's construction tools (T6.1d), drawing title blocks (T6.4a), takeoff
// exports (T6.3b) and the IFC header (T6.6a). The long form opens `docs/user/construction.md`;
// keep the two saying the same thing when either changes.
//
// Drafted in T6.0c; the project owner rewords it in a follow-up. Whatever the wording, it must
// never call a structure or a member "safe", "compliant" or "OK" (the tests check that).

export const DISCLAIMER_SHORT =
  'Not an engineering tool: manufakture lays out framing by rules you choose. It does no ' +
  'structural calculation and no load, span, bracing or building code check. Sizes, spacing ' +
  'and headers are your decisions. Consult your local building authority and a qualified ' +
  'professional before building. Provided without warranty under GPL-3.0-or-later.';
