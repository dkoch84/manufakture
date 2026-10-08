// @manufakture/domain-construction/files: the construction domain's fabrication files (M8 plan
// T8.1b): the takeoff CSV and PDF. Apart from the package root because it loads
// `@manufakture/io`'s writers at run time, which the domain logic never needs (ADR 0015 decision
// 1). See README.md, "Takeoff files".

export {
  exportTakeoff,
  takeoffFile,
  type TakeoffFileKind,
  type TakeoffFileOptions,
} from './takeoff';
export { takeoffPdf, wrap, type TakeoffPdfOptions } from './takeoff-pdf';
