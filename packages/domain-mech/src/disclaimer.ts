// The short form of the mechanical domain's notice (ADR 0017 decision 17). One string for the
// mech panels, every specification (first page and footer), the title block of every diagram and
// schematic sheet, every BOM, harness and netlist export, the review bundle's mech summary and
// the `disclaimer` field of the mechanical MCP tools' results. The long form opens
// `docs/user/mechanical.md`; keep the two saying the same thing when either changes.
//
// PLACEHOLDER: drafted by the agent (task T9.1e, as the maintainer decided on 2026-10-10); the
// maintainer may reword it at M9 acceptance (T9.12b, task #1269). Whatever the wording, nothing
// the domain shows may call a design safe, certified, compliant, passing or OK: the notice itself
// is the one place that says it does not.
//
// Construction's notice (`@manufakture/domain-construction`) is separate and unchanged; a
// document using both domains shows each where its own domain's output appears.

export const DISCLAIMER_SHORT =
  'manufakture calculates by the methods and inputs shown in each record; it does not certify ' +
  'a design as safe or compliant with any standard. Catalog data is typical and unverified ' +
  'unless marked. Have a qualified engineer review any machine that carries load or stores ' +
  'energy before building or using it. Provided without warranty under GPL-3.0-or-later.';

/** Whether `DISCLAIMER_SHORT` is still the agent's draft, awaiting the maintainer (T9.12b). */
export const DISCLAIMER_IS_PLACEHOLDER = true;
