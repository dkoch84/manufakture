# Derived parts

A **derived part** brings the bodies of a part from another document into the part you are working on: a bracket designed once and used in several assemblies of parts, a standard hub that every wheel starts from. It is pinned to a **named version** of its source, so it never changes behind your back: later edits to the source show up only when you choose to update to a newer version.

The pinned version travels inside your document. Saving, undo, a `.mfk` export and an import elsewhere all keep it, and the part still builds when the source document is deleted or was never in that browser at all.

## Inserting a derived part

**Derived part** in the feature toolbar opens the dialog. From the top:

- **Document**: any document in this browser's storage, this one included (marked "this document"). Deriving from an older version of the document you are in is fine: a version is a fixed copy, so a part can never end up built from itself.
- **Version**: the document's named versions, newest first, as the History panel shows them. **Use** picks one. If the state you want has no name yet, **Create version now** names the source document's current state there and then and picks it (for this document, anything not saved yet is saved first, as **Create version** in the History panel does). See [Version history](history.md) for versions.
- **Part studio**: which part studio of that version to take the bodies from (the first one is chosen for you).
- **Source bodies**: **All bodies** (the default) takes every body that part studio makes, including ones a later version adds. Untick it to choose some. The list shows the bodies the source's features make and the bodies it has names or colours for; a body made only by a pattern or mirror is listed once it has a name in the source, and **All bodies** always includes it.
- **Placement**: **Move along X, Y, Z** and **Rotate about X, Y, Z**. The rotations are about the origin, in that order, then the move. Each field takes an expression, so `#gap + 5` or `90 deg` work as anywhere else.
- **Result**: **New body** keeps the derived bodies as bodies of their own; **Add**, **Remove** and **Intersect** combine them with this part's bodies, as an extrude does. With more than one body in the part, **Combine with** chooses which of them.

**OK** adds it at the rollback bar as one step (**Undo** takes it back); **Cancel** or Escape leaves the document alone.

Only the chosen version is read from the source: the dialog lists that document's versions and reads one version back, nothing else. The source document's own state does not matter, so it may be open in another tab.

## In the feature tree

A derived part's row shows where it comes from: "From Bracket at 6 mm", the source document and the pinned version.

- **Update available** appears when the source has versions named after the pinned one. Hovering it lists them.
- **Update** lists the source's versions, the pinned one marked. **Use** on another moves the pin to it: the part is rebuilt from that version, and everything built on it (a fillet on one of its edges, a hole through it) follows, because derived faces keep their names from the source. It is one step: **Undo** goes back to the version before. You can move to an older version the same way.
- **Open source** opens the source document read-only at the pinned version, in the version viewer (see [Version history](history.md)). Your document is saved first. **Back** leaves the source document open as it is now; open your document again from **Documents**.
- **Source not here** means the source document is not in this browser (the document came in a `.mfk` file, or the source was deleted). The part still builds from the version it carries; there is just nothing to update to or open.

Double-clicking the row (or **Edit**) opens the dialog again, to change the bodies, the placement or the result. The pin stays as it is unless you press **Change source or version**, which shows the document, version and part choices again.

The tree reads the source documents' versions when the part studio is shown. A version named in another tab meanwhile shows up the next time you open the document.

## Faces and edges of derived bodies

Faces of a derived body are named after the faces of the source, with the derived feature in front: `derived#1:from/extrude#1:side:e3`. You pick them in the viewport like any other face or edge. Because the names come from the source's own naming, a fillet, chamfer or sketch on a derived face finds the same face again after an update, as long as the source still has it; the feature tree's status shows any reference that was lost, with a re-pick, as for local features.

## Example

1. Build the bracket of the M1 walkthrough in a document named "Bracket", with `#thickness` at 6 mm. In **History**, **Create version** "6 mm".
2. On the **Documents** screen, **New document**. **Derived part**: choose "Bracket", **Use** "6 mm", leave the part studio and **All bodies**, **OK**. The bracket appears, and Measure shows the same volume as in "Bracket".
3. **Fillet** the top edge at the end of the foot, radius 2 mm.
4. Open "Bracket" again, set `#thickness` to 8 mm, and **Create version** "8 mm".
5. Back in the new document, the derived part says **Update available**. **Update**, then **Use** "8 mm": the foot is 8 mm thick and the fillet is still on its edge.
6. Export the new document as a `.mfk`. It builds anywhere, with or without "Bracket".
