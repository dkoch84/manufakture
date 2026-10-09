// Writes the enclosure fixture into a library directory, for the scenario's live run (an agent
// driving the MCP server over stdio with MANUFAKTURE_LIBRARY pointing at that directory):
//
//   node --import ../../../../../packages/session/src/worker/ts-hooks.ts make-library.ts /abs/dir
//
// The directory must exist; the document lands on Main as `doc-enclosure`.

import { DocumentLibrary } from '@manufakture/library';
import { NodeBackend } from '@manufakture/library/node';
import { enclosureDocument } from './enclosure';

const root = process.argv[2];
if (root === undefined || !root.startsWith('/')) {
  process.stderr.write('usage: make-library.ts <absolute library directory>\n');
  process.exit(2);
}
await new DocumentLibrary(new NodeBackend(root)).create(enclosureDocument());
process.stderr.write(`enclosure written to ${root}\n`);
