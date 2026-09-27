# Documents and files

manufakture keeps your documents in your browser. There is no account and no server: every change is saved on this computer as you work, and a document moves to another machine as a `.mfk` file.

## Saving happens by itself

Every change (a new feature, an edit, an undo or redo, a rename) is saved a moment after you stop, and at least every few seconds while you keep going. The header shows where things stand, next to the document's name:

| Header          | Meaning                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (nothing)       | Nothing has changed since the document was opened.                                                                                                                                                                                              |
| Unsaved changes | A change waits for the pause.                                                                                                                                                                                                                   |
| Saving...       | Being written.                                                                                                                                                                                                                                  |
| Saved           | Everything is saved.                                                                                                                                                                                                                            |
| Not saved: ...  | The last save failed, with the reason (usually a full disk). Your changes are kept, and saved again by themselves after a few seconds (waiting longer after each failure, up to a minute), on your next change, or when you leave the document. |

If you close or reload the tab while a change is not saved yet (or a save failed), the browser asks you first.

While the open document's changes cannot be saved, the Documents screen will not open, create or import another document in its place: it says why, and offers **Save again** and **Export the open document**, which downloads it as a `.mfk` file as it is, unsaved changes included.

A new document is saved on its first change, so opening the app and closing it again leaves nothing behind. Reloading the page opens the document you were working on (its id is in the address, `?doc=...`); opening the app without one opens the most recently saved document.

Imported reference bodies come back too: the files you imported are stored with the document, and are read again when it opens.

## The Documents screen

**Documents** in the header lists every document in this browser, most recently saved first, with when it was saved and how much space it takes. From there:

- **New document** starts an empty one.
- Click a name to **open** it. **Back to ...** returns to the one that is open.
- **Rename** changes the name (Enter to keep it, Escape to cancel). Renaming the open document is a step you can undo.
- **Duplicate** makes an independent copy, named "... (copy)".
- **Export** downloads the document as a `.mfk` file.
- **Delete** asks once more, then removes the document and everything stored with it. There is no undo for this: export first if in doubt. Deleting the open document leaves a new, empty one open.
- **Import .mfk** opens a `.mfk` file as a new document. You can also drop a `.mfk` file anywhere on the page. (Dropping a STEP or STL file on the editor imports it as a reference body, like **Import**.)

At the bottom the screen says where documents are kept and how much space the site uses. Browsers may clear a site's storage when the disk runs low, unless the site is allowed to keep it: manufakture asks for that after the first save, and **Keep my documents** asks again. Some browsers decide by themselves, some ask you. Either way, export the documents that matter.

In a browser that offers no storage at all (some private windows), the Documents screen says so: nothing survives a reload there, so export before closing the page.

## The same document in two tabs

You can open a document in two tabs or windows, but edit it in one. The tabs never save over each other: each save checks that the document is still the version this tab opened or last saved. If another tab saved it in between, this tab does not save; a message under the header says so and offers two choices:

- **Load the newer version** opens what the other tab saved, and drops the changes made in this tab since its last save.
- **Keep this version as a copy** saves this tab's version as a new document named "... (copy)" and opens it; the other tab's version stays as it was.

Until you choose, this tab's changes are not saved (the header says **Not saved**), and closing the tab asks first. In browsers with the Web Locks API (all current ones), two tabs also never write a document's files at the same moment; without it, saving in two tabs at once can in rare cases leave one tab's version stored under the other's pointer, and the document then opens with whichever version was written last.

If you delete a document on the Documents screen of one tab while another tab still has it open, the other tab does not know: its next change saves the document again, as a new document with that tab's version (and only the history recorded since then). Close or switch away from the document in the other tabs before deleting it.

## .mfk files

A `.mfk` file is a zip archive holding:

- `document.json`: the document (its features, sketches, variables and settings) in the manufakture file format, with each imported file replaced by a reference to it;
- `blobs/<sha256>`: each imported STEP or STL file, once, named by its SHA-256.

The part itself (its shape and meshes) is not in the file: it is rebuilt from the features when the document opens, so the file stays small and always matches the features.

A `.mfk` from somewhere else is treated with care. Importing it checks, before anything is unpacked, that the file is at most 256 MB (a larger file is refused before it is read), holds at most 1000 entries, that no two entries share packed data and none reaches outside the file, and that `document.json` (64 MB) and each imported file (20 MB, the import limit) stay within their sizes, and 512 MB in all, counting each entry at the larger of its packed and unpacked sizes; any other entry is ignored, and only the usual zip compression (deflate, or none) is read. While unpacking, an entry that turns out to unpack to more than it claims (or less) is refused at that point, so a file cannot make the browser unpack gigabytes. Every imported file must match the SHA-256 the document records for it. The document is then brought up to date from older versions of the format and checked like any file. A document made by a newer version of manufakture is refused with a message saying so, and nothing is stored.

An import keeps the document's id unless a document with that id is already here (you exported it and did not delete it), in which case it gets a new one: importing never replaces a document.

## How saving survives a crash

A save never overwrites the copy it replaces. Each save writes a new numbered copy of the document, and only then updates a small pointer file naming the current copy (with its checksum). The copy before is kept as a spare. When a document opens, manufakture takes the newest copy that reads completely, and repairs the pointer if a crash left it behind or broken. A copy that reads as a valid document is used even when its checksum does not match the pointer (the pointer is corrected), and recovery never deletes the copy the pointer names or any earlier one. A later copy that is complete but cannot be read (an imported file it needs went missing, say) is set aside under a `damaged-` name rather than deleted, and the document opens from the copy before it with a note saying it was recovered; the set-aside copy is removed only when you delete the document. So if the browser or the computer dies halfway through a save, you get either the last complete save or the one being written, never a damaged document.

Beside the copies, each save records the commands since the previous one (what you did, in order), the start of a version history.
