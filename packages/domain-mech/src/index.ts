// @manufakture/domain-mech: the mechanical domain (M9, ADR 0017). Mechanical and electrical in one
// domain: its settings (`domains.mech`, with no safety factor shipped), its registration on
// regen, the review summarisers for the settings and for core's typed `mech` section, and the
// short notice every mechanical output carries. The model itself (requirements, load cases,
// drivetrains, purchased parts, the electrical system, schematics, studies, check overrides,
// specification notes, hazards, test bands) is core's `mech` section. Purchased parts (the
// catalog model, BOM lines, the `mech.placeholder` feature) are `./parts`; the built-in family
// catalogs and the motor constant conversions are `./catalog`; the resistance laws, motions, duty
// cycles and templates of requirements and load cases are `./requirements`. See README.md.

export const packageName = '@manufakture/domain-mech';

export { DISCLAIMER_IS_PLACEHOLDER, DISCLAIMER_SHORT } from './disclaimer';
export { MECH_IMPLEMENTATION, mechDomain, registerMech } from './domain';
export {
  mechDataSummariser,
  mechSectionSummariser,
  type DomainDataSummariser,
  type SectionSummariser,
} from './review';
export {
  DEFAULT_MECH_SETTINGS,
  MAX_SAFETY_FACTOR,
  MECH_NAMESPACE,
  MECH_SETTINGS_VERSION,
  factorFor,
  factorSetting,
  factorText,
  mechSettings,
  mechStarted,
  readMechSettings,
  setFactorsCommand,
  type MechFactors,
  type MechSettings,
  type ReadSettings,
  type StartFactors,
} from './settings';
export * from './parts';
export * from './catalog';
export * from './checks';
export * from './requirements';
