// What a merge checks a field-merged domain value with: the app's domains read it as they would
// read it from a document (sync's `./merge`), so a merge never keeps a combination of two
// branches' domain data or extension params its domain cannot read.

import { constructionDomain } from '@manufakture/domain-construction';
import { woodDomain } from '@manufakture/domain-wood';
import { stockDomain } from '@manufakture/stock';
import { domainsValidator, type MergeValidator } from '@manufakture/sync';

/** The domains the regen worker registers: stock, wood and construction. */
export const appMergeValidator: MergeValidator = domainsValidator([
  stockDomain,
  woodDomain,
  constructionDomain,
]);
