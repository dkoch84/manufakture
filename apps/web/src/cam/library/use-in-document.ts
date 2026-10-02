// "Use in document" (T5.1d): the command that copies a library tool into a document's `cam.tools`.
// The copy is independent: editing it, or the library, changes nothing on the other side; its
// `source` remembers where it came from.

import { previewIds, type Command, type ManufaktureDocument } from '@manufakture/core';
import { libraryToolToCamTool, type LibraryTool } from '@manufakture/cam/library';

export type AddCamToolCommand = Extract<Command, { type: 'addCamTool' }>;

/**
 * The `addCamTool` command that copies `tool` from library `library` (`builtin`, or the user
 * library's id) into `doc`, under the document's next tool id.
 */
export function useToolInDocument(
  doc: ManufaktureDocument,
  tool: LibraryTool,
  library: string,
): AddCamToolCommand {
  const [id] = previewIds(doc.cam.nextIds, 'tool');
  return { type: 'addCamTool', tool: libraryToolToCamTool(tool, id!, library) };
}
