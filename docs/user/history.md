# Version history

Every save keeps a record of what you did (each change, undo and redo, in order), and you can give the document's state a name at any moment: a **version**. From the **History** panel you can look at any version, or at any saved state since the history began, compare it with what you have now, and bring it back.

## The History panel

**History** in the header, next to **Documents**, opens the panel at the top of the side panel; press it again (or **Close** in the panel) to put it away. It has two lists.

**Versions** are the states you named, newest first, each with its name, when it was made, the saved revision it names and its description. A version made in another browser of a [synced](sync.md#versions-and-branches) document says **from the server** instead of a revision: this browser keeps its state, but not the history that led to it.

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

To bring a branch's work into another one, merge it (below). To take another branch's whole state instead, name it as a version on that branch, switch back, **View** the version and **Restore** it: the open branch then takes the other one's whole state, as one step that **Undo** takes back.

When the document [syncs](sync.md#versions-and-branches), versions and branches made on Main go to your server and appear in your other browsers; the changes made on a branch stay in the browser they are made in.

Branches are for trying alternatives inside one document. To make an independent copy, use **Duplicate** on the home screen: the copy has its own name and history, and lives on as a document of its own.

On the home screen a document is its Main branch: the name shown is Main's, and **Rename** and **Export** act on Main, even for the document you have open on another branch (to export a branch, **Duplicate** the document while the branch is open and export the copy). **Duplicate** of the open document copies it as it is open, on its branch. An export with every version includes the versions of all branches (imported again, they all become versions of Main; branches themselves are not exported).

If another tab deletes the branch you are on, your next change cannot be saved and the conflict banner shows; **Load the newer version** then opens Main and drops the changes made on the deleted branch, and **Keep this version as a copy** saves them as a new document.

## Merging a branch

**Merge** brings another branch's work into the branch you have open. It sits in the **History** panel, above the timeline, whenever the document has more than one branch.

1. Open the branch you want to merge **into** (say Main).
2. In **History**, under **Merge**, pick the branch to merge **from**, then **Preview merge**.
3. Read the preview, then **Merge** (or **Cancel**).

A merge takes the changes the other branch made since the two branches parted (the version one of them was made from) and makes them again, one by one and in their order, on top of what you have open, including anything not saved yet. The preview shows, before anything changes:

- **Applies**: the changes that go in, by the names the timeline gives them ("Edit variable #thickness", "Add Fillet 2").
- **Renamed ids**: when both branches added something with the same id (both made `fillet#2`, say), the merged one gets the next free id here (`fillet#2 becomes fillet#3`), and every later merged change that names it follows. What you already have keeps its ids.
- **Does not apply**: changes that no longer make sense here, each with the reason: an edit of a feature this branch deleted, or a delete of a feature something here now depends on. They are left out; the other branch still has them.
- **Replaced whole**: things this branch changed since the branches parted that the merge changes again. **A merge never combines two edits of the same thing field by field.** The unit is the whole object: a feature, a variable, a part studio's settings, an assembly. When both branches changed the same feature, the merged branch's version of the whole feature replaces this one's, so if you made a fillet's radius 2 here and the other branch made the same fillet's radius 4 and renamed it, you get radius 4 and the new name. If you edited a different field of that feature here, that edit is gone too. Check this list before you merge; to keep your side, cancel, and change the other branch first (or merge, then edit).

A restore on the other branch (**Restore** of a version) is merged as what it means: the document becomes that version's state again, on top of what you have here, with fresh ids for anything newer. So it replaces this branch's work too, and the preview lists what it replaces.

**Merge** is one step: the Undo button says "Undo Merge "10 mm"", and **Undo** takes the whole merge back, **Redo** brings it again. It is saved as one revision in the timeline, labelled with the merge, so the state before it stays in the history. The branch you merged from is not changed. If the document changed after the preview, **Merge** shows the preview again as it is now instead of merging the old one.

Merging needs no server and no connection: it works on the copy in your browser.

Merging the same branch twice makes its changes again: anything it added is added a second time, under new ids. After a merge, carry on in one of the two branches, or make a new branch from a version of the merged result.

Merging is offered for the open branch only, so to merge Main into a branch, open the branch and merge from Main.

A branch made from a version that came from another browser (marked **from the server**) cannot be merged in this browser, because the history before that version is not here; the preview says so. Merge it in the browser where the version was made.

## Reviewing an agent's work

An AI agent connected to manufakture never changes Main. It works on a branch of its own, an **agent branch**, and when it is done it submits the branch for review with a **review bundle**: what it changed, pictures of the part before and after, measurements and quantities. You decide in History whether its work goes into Main.

Agent branches are marked wherever branches show:

- In the branch list next to the document name they are grouped under **Agent branches**. Hovering one shows which agent made it, its session and its review state; while one is open, the same line shows next to the list.
- In **History**, under **Agent branches**, each is listed with the agent's name, its session and its review state, and a **Review** button. The agent's name is what its program calls itself: it is shown, never checked.

A review state is one of **Open** (the agent is working), **Submitted for review**, **Changes requested**, **Approved** and **Rejected**.

### The Review view

**Review** opens the agent branch's bundle beside the side panel. At the top: who made the branch, its state, the agent's note to you and your last comment. Then the checks, the buttons, and the bundle itself, geometry first:

- **Renders**: the same views of the part before (Base) and after (Head) the agent's work, side by side. Each picture is checked against the fingerprint (SHA-256) and size the bundle gives before it is shown; one that does not match says so instead.
- **Measurements**: each body's volume, area and mass before and after, and overlaps in assemblies.
- **Regen errors**: new errors first, then those already there, then those the agent fixed.
- **Quantities**: what changed in the cut list, the hardware and the takeoffs.
- **Features**: per part studio and assembly, what was added, deleted, edited (with the fields before and after), renamed, reordered or suppressed; other document changes; domain data.
- **Scripts**: every script on the branch, in full, read from the branch itself rather than from the bundle, since that is what **Run scripts** would run. Those the bundle lists as added or changed come first. A script holding hidden characters (that can make it look different from what runs) is flagged, and the characters show as escapes such as `\u{202e}`.
- **Commands**: every batch the agent made, with a readable line per command; **JSON** shows the command itself.

Everything in a bundle was written by the agent or by whoever wrote the document, so it is shown as plain text, never as a web page, with invisible characters (direction overrides, zero-width marks) shown as escapes so they cannot change what you read. Long text is cut, with **Show all** to read the rest, and long lists show 50 at a time, with **Show more**.

### The checks, and Approve

manufakture does not take the bundle's word for anything. **Approve** is offered only when all of these hold, and the view says which one does not:

1. **The bundle describes the branch as it is.** A change saved on the branch after the bundle was made (by the agent, or by you) makes it **stale**: the agent has to submit again.
2. **The bundle's scripts are the branch's.** A bundle that shows a script otherwise than the branch has it blocks Approve, and the difference is listed.
3. **Your own regen matches the bundle.** With the branch open, manufakture rebuilds it itself and compares every body (which bodies there are, their names, volume, area, bounding box and mass) and every feature's errors with the bundle, to a billionth of each value (a millionth of a millimetre near zero). Any difference is listed, never hidden. **Open the branch** opens it when another branch is open. Errors of scripted features are not compared, since they depend on which scripts may run. A very large bundle may leave some bodies or errors out; what your regen has beyond its lists is then shown, and Approve waits until you tick **I have checked these myself** (more than the bundle left out is a difference).
4. **Everything applies on Main.** The merge into Main as it would be made now is previewed: nothing may be left out.
5. The branch is **Submitted for review**.

**Approve** checks all of that again at the moment it acts, and then, in this order:

1. opens Main (what is pending on the branch is saved first);
2. previews the merge onto Main as it is open: nothing may be left out;
3. reads the branch again: it must still be what the bundle describes;
4. marks the branch **Approved** (from then on the agent cannot write to it);
5. merges the agent's work into Main (as **Merge** does, above) as one step labelled with the session ("Approve agent session ..."); when that fails, the branch goes back to **Submitted for review**;
6. saves Main;
7. records a version of Main named "Approved: ..." that remembers which branch, session, agent and bundle it came from.

**Undo** takes the whole merge back in one step and **Redo** brings it again; the branch stays **Approved** either way. The branch and its bundle are kept. If anything changed in the meantime (the agent wrote to the branch, say), nothing is merged and the reason is shown.

If the tab closes (or Main cannot be saved, or the version cannot be recorded) after the branch was marked approved, the branch is **Approved** but no version of Main records it. Its Review view says so and offers **Finish approval**: the same checks, then the merge if Main does not have it yet (one already saved is not merged twice) and the version.

Review does not hold back exports: G-code, cut lists and every other file export from any branch, an agent's unreviewed branch included. What review decides is whether the agent's work gets into Main, which only **Approve** does.

### Request changes and Reject

- **Request changes** asks what the agent should change. Your comment is stored with the branch (up to 4,000 characters), the state becomes **Changes requested**, and the agent reads the comment when it asks for its review. When it carries on, the branch is **Open** again, and it can submit again.
- **Reject** closes the branch: the agent cannot write to it again. Main is not changed.

### Scripts in an agent branch

An agent can add or change scripts, so on an agent branch the scripts do not run just because you allowed this document's scripts before (on Main, say). The banner over the document lists every one of them, and **Run scripts** there allows exactly those, each as the branch has it now, on this device: a script the agent changes afterwards is asked about again. Read the scripts in the review first. The scripts of derived parts' source documents do not run on an agent branch, even when you allowed those documents.

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
11. On `Thick walls`, round the inside corner with a 4 mm **Fillet**.
12. Pick **Main**, then in **History** under **Merge** pick `Thick walls` and **Preview merge**. **Applies** lists the thickness edit and the fillet; **Replaced whole** lists `the variable #thickness`, since Main changed it to 8 mm and the branch's 10 mm replaces it.
13. **Merge**: Main has the 10 mm bracket with the fillet. **Undo** takes the whole merge back to 8 mm without the fillet; **Redo** brings it again.
