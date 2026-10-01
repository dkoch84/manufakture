# Version history

Every save keeps a record of what you did (each change, undo and redo, in order), and you can give the document's state a name at any moment: a **version**. From the **History** panel you can look at any version, or at any saved state since the history began, compare it with what you have now, and bring it back.

## The History panel

**History** in the header, next to **Documents**, opens the panel at the top of the side panel; press it again (or **Close** in the panel) to put it away. It has two lists.

**Versions** are the states you named, newest first, each with its name, when it was made, the saved revision it names and its description.

The **Timeline** is every saved revision, newest first, grouped into sessions: saves that follow each other with less than half an hour between them belong to one session, headed by when it began and ended. Each revision shows when it was saved and what led to it ("Edit variable #thickness", "Undo Add Extrude 1"; after three, "and 2 more"). A revision that a version names carries that version's name.

A document that was never saved (a new one before its first change) has no history yet; its first change saves it.

On a branch (below), the panel shows that branch's name next to its title, and the timeline is the branch's own. The Versions list holds the versions of every branch, so you can view or restore any of them; a version made on another branch carries that branch's name.

## Creating a version

**Create version** asks for a name (1 to 200 characters) and, if you like, a description, then **Save version**. It saves anything not saved yet first, so the version is exactly what you see. A version is kept for good, whatever you do later: the saved copy it names is never cleaned up. Other documents can rely on that (a derived part pins a version of its source).

## Viewing a version or a revision

**View** on a version, or on a revision in the timeline, shows that state in place of the current one, in the same window. A yellow banner under the header says what you are looking at ("Viewing Version "6 mm"") and lists what differs from the current state:

- features only in the viewed state, only in the current state, or different in the two;
- variables only in one of them, or with different values;
- part studios, assemblies, the configuration table, the document name and display units, when they differ.

"Same as the current state" means nothing differs.

The viewed state is rebuilt by the geometry kernel, so the viewport, the feature tree's results and **Measure** are those of that state: select a face or nothing at all and Measure gives its areas and volume. It is read-only: the feature tools, Undo and Redo, **Create version**, the Variables and Configurations panels, importing and exporting are off, and the tree cannot be changed. You can still switch between its part studio tabs to look at each one, but not add, rename, move, duplicate or delete them. Hiding or showing a body while viewing applies to the view only; the current document keeps its own hidden bodies. Imported reference bodies the viewed state has are read again from their stored files, even if you have deleted them since. Your current document is not touched and keeps saving as usual.

Revisions older than the start of the history cannot be viewed (their **View** is off). That only happens for documents saved by an older release of manufakture, before the history kept every revision.

## Going back, restoring

- **Back** leaves the view and shows the current state again.
- **Restore** makes the viewed state the current one. It is one step: **Undo** takes it back (the Undo button says "Undo Restore Version "6 mm""), and Redo brings it back again. The restore is saved and recorded in the timeline like any other change, so the history never loses anything: the state you restored over is the revision just before it.

A restore brings back everything in the document: part studios, features, variables, assemblies and configurations, and the document's name. Ids handed out since then are not handed out again (new part studios, assemblies and configuration rows get fresh ids, and so do new features in any part studio the current state also has), so newer work never gets mixed up with the restored state. One exception: a part studio or assembly that you deleted after the version and that the version brings back continues from its own numbering as it was in the version, so a feature added to it later can get an id that one of its features had after the version was made.

## Branches

A **branch** is a second line of work in the same document, started from a version: try a wider wall or a different hole pattern without touching the main design, and switch between the two whenever you like. Every document has a **Main** branch, which is the document as it always was (documents saved before branches existed are their Main branch, unchanged).

- **Branch from a version.** **View** a version, then **Branch** in the yellow banner. Give the branch a name (1 to 200 characters, different from the document's other branches), then **Create branch**. The branch starts at exactly that version's state and opens at once; anything not saved on the branch you were on is saved there first. **Branch** is offered for versions only: name a revision as a version first to branch from it.
- **Switch branches** with the branch list next to the document name. Each branch keeps its own saved state, its own timeline and its own versions; switching saves what is pending on the branch you leave, then opens the other one. Undo starts empty on the branch you switch to, as it does when you open a document (the timeline still has every saved step). If that save fails, you stay where you are and the reason is shown.
- **The link names the branch.** The page address gains `&branch=<id>` while a branch other than Main is open, so a reload or a bookmark opens that branch again. An address without it opens Main, as before. If the branch in a link was deleted since, the document opens on Main and says so.
- **Rename branch** and **Delete branch** sit next to the list while a branch other than Main is open. Main cannot be renamed or deleted. Deleting asks first, removes the branch and its history for good, and opens Main; Main is not touched. A branch that has a named version cannot be deleted, since versions are kept for good and other documents may rely on them.
- **Versions remember their branch.** A version made while a branch is open names that branch's state, and opens from it wherever you view it. You can branch from any version, whichever branch is open. Another document that pins a version (a derived part) sees the versions of every branch.

There is no merging. To bring a branch's work onto Main, name it as a version on the branch, switch to Main, **View** that version and **Restore** it: Main then takes the branch's whole state, as one step that **Undo** takes back. The same works in the other direction, and between any two branches.

Branches are for trying alternatives inside one document. To make an independent copy, use **Duplicate** on the home screen: the copy has its own name and history, and lives on as a document of its own.

On the home screen a document is its Main branch: the name shown is Main's, and **Rename** and **Export** act on Main, even for the document you have open on another branch (to export a branch, **Duplicate** the document while the branch is open and export the copy). **Duplicate** of the open document copies it as it is open, on its branch. An export with every version includes the versions of all branches (imported again, they all become versions of Main; branches themselves are not exported).

If another tab deletes the branch you are on, your next change cannot be saved and the conflict banner shows; **Load the newer version** then opens Main and drops the changes made on the deleted branch, and **Keep this version as a copy** saves them as a new document.

## Example

1. Build a bracket whose walls are the variable `#thickness`, at 6 mm.
2. Open **History**, **Create version**, name it `6 mm`.
3. Change `#thickness` to 8 mm.
4. **View** the `6 mm` version: the banner says "Variables that differ: #thickness.", and with nothing selected, Measure shows the 6 mm bracket's volume, 14729.78 mm³.
5. **Back**: the 8 mm bracket is shown again (19226.16 mm³).
6. **View** `6 mm` again and **Restore**: the bracket is 6 mm, as the current state.
7. **Undo**: it is 8 mm again.
8. **View** `6 mm` again, **Branch**, name it `Thick walls`, **Create branch**: the bracket is 6 mm again, on the new branch.
9. Change `#thickness` to 10 mm there.
10. Pick **Main** in the branch list: the bracket is 8 mm. Reload: still 8 mm, on Main. Pick `Thick walls`: 10 mm.
