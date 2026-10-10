// The purchased parts catalog as plain data for agents (`manufakture://tables/parts` in the MCP
// server, ADR 0017 decision 7): every family's rating fields with their kinds and BOM comparisons,
// the placeholder shapes, and the built-in entries at every version, each with its sources and
// `verified` flag. Ratings are SI, dimensions millimetres, masses kilograms.

import { CATALOG_FAMILIES } from '@manufakture/core';
import { DISCLAIMER_SHORT } from '../disclaimer';
import { BUILTIN_ENTRIES } from './catalog';
import { familySchema } from './families';
import { PLACEHOLDER_SCHEMA_VERSION, PLACEHOLDER_SIZES, PLACEHOLDER_TYPE } from './placeholder';

export function partsTables() {
  return {
    notice: DISCLAIMER_SHORT,
    units: { ratings: 'SI (N, N*m, A, V, ohm, rad/s, Hz, K, ...)', dimensions: 'mm', mass: 'kg' },
    description:
      'Purchased parts with ratings. Use one by reference: { source: "builtin", id, version } for an entry below (the version pins its numbers), or { source: "document", id: "entry#n" } for an entry of the document, added with setCatalogEntry. Place it with addPart, then addFeature of the placeholder feature below (or an import feature, operation "reference", holding the STEP file), then setPurchasedUse naming the entry and the part; an addInstance puts it in an assembly, and the instances give the count in bom-csv. A use with no part counts its quantity (a number expression). Catalog data is typical and not verified unless marked: check the maker\'s current datasheet.',
    placeholder: {
      kind: 'extension',
      extension: PLACEHOLDER_TYPE,
      schemaVersion: PLACEHOLDER_SCHEMA_VERSION,
      operation: 'new',
      params: {
        entry: 'the catalog reference',
        shape: Object.keys(PLACEHOLDER_SIZES),
        axis: ['x', 'y', 'z'],
      },
      expressions: PLACEHOLDER_SIZES,
      note: 'Sizes are length expressions (from the entry dimensions of the same names). A cylinder and a ring are centred on the axis and extruded from the origin along it; a box is centred on the axis, length and width across it, height along it.',
    },
    families: CATALOG_FAMILIES.map((f) => {
      const s = familySchema(f);
      return {
        family: f,
        label: s.label,
        fieldsVersion: s.fieldsVersion,
        placeholder: s.placeholder,
        dimensions: s.dimensions.map((d) => ({ ...d })),
        ratings: s.fields.map((x) => ({
          ...x,
          ...(x.options ? { options: [...x.options] } : {}),
          ...(x.conventions ? { conventions: [...x.conventions] } : {}),
        })),
      };
    }),
    entries: BUILTIN_ENTRIES.map((e) => structuredClone(e)),
  };
}
