# Importing and exporting

**Export** in the header saves the model's bodies (or a whole assembly) as a file for a slicer or another CAD program. **Import** brings a STEP or STL file in as a reference body. Both need the geometry kernel, so they are available once the model has loaded.

## Export

Click **Export** and pick a format:

| Format                     | What you get                                                                                                        | Use it for                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **STL**                    | One binary STL file with every body, in millimetres                                                                 | Any slicer; the most widely read mesh format    |
| **STL, one file per body** | A binary STL file for each body, named after it                                                                     | Printing bodies separately                      |
| **3MF**                    | A 3MF file: millimetres, one named object per body                                                                  | OrcaSlicer, Bambu Studio, PrusaSlicer, Cura     |
| **STEP**                   | A STEP (AP214) file with the exact geometry, each body a named product; no triangles, so no tolerance applies to it | FreeCAD, Fusion, Onshape, SolidWorks, and so on |

Export saves the bodies of the part studio you are in. Imported reference bodies are never exported, whether they are shown or hidden by **Undo**: they belong to another file, and you already have it.

When the part has several [bodies](bodies.md), the menu lists them with a checkbox each: the shown ones are ticked, the hidden ones are not, and the ticks follow the view while the menu is open until you change one. Tick the bodies to export, then pick the format. A part whose only body is hidden exports nothing: the menu says so instead. Each body is written under its name from the Bodies list: an object in 3MF, a product in STEP, a file of its own in **STL, one file per body**.

In a document with [configurations](configurations.md), **Every configuration** in the menu exports one file per configuration.

The file downloads straight away, named after the body (or the document, when there are several bodies). The header says what was saved and how big it is.

### Exporting an assembly

In an [assembly](assemblies.md) tab, **Export** saves the whole assembly, every part where its instances are, in one file named after the assembly:

| Format   | What you get                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **STL**  | One binary STL file with every instance's bodies moved into place                                                                                                                            |
| **3MF**  | One object per part, written once, and the build places it once per instance; a part of several bodies is one object made of its bodies                                                      |
| **STEP** | A STEP assembly: each part once, as a product named after the part (a part of several bodies is a sub-assembly of its bodies), and each instance a placed component named after the instance |

Two instances of a part are two placements of one part in 3MF and STEP, not two copies, so a CAD program lists the part once. Suppressed instances are left out, and so are instances that could not be built (the header names them). The positions are those of the last solve: a drag that is still going on is not exported. There is no **STL, one file per body** and no **Every configuration** in an assembly. Colours, materials and print plates are not written yet.

### Mesh tolerance

STL and 3MF are made of flat triangles, so curved faces (fillets, holes, rounds) are approximated. **Mesh tolerance**, at the bottom of the Export menu, sets how closely:

| Setting    | Largest gap to the true surface | Largest angle between facets | Notes                              |
| ---------- | ------------------------------- | ---------------------------- | ---------------------------------- |
| Draft      | 0.1 mm                          | 28.6 degrees                 | Small files; visible facets        |
| **Normal** | 0.02 mm                         | 14.3 degrees                 | The default; fine for FDM printing |
| Fine       | 0.005 mm                        | 5.7 degrees                  | Small or precise round parts       |

Hover over the setting to see its values. A finer tolerance gives larger files and slower slicing, and past what the printer can resolve it changes nothing in the print.

### Every exported mesh is watertight

Before an STL or 3MF file is written, its triangles are joined into one closed surface and checked: every edge must be shared by exactly two triangles that face the same way, with no gaps, no flipped triangles and no zero-size triangles. A body that fails the check is not exported; you get a message saying what was wrong instead of a file your slicer would have to repair.

### Checking an export in OrcaSlicer or Bambu Studio

1. Export as **3MF**.
2. In OrcaSlicer or Bambu Studio, import it from the **File** menu, or drag the file onto the plate.
3. The part appears at its real size, named after the body in the object list. Bambu Studio may say the file was not made by Bambu Studio and load the geometry only; that is expected, since manufakture writes geometry, not slicer settings.
4. Slice. The slicer should report no errors about the mesh (no "open edges" or "non-manifold" warnings, and no automatic repair).

## Import

Click **Import** and pick a file:

- **STEP** (`.step`, `.stp`): read by the geometry kernel as exact geometry. The body is named after the first product in the file, or the file name. Its faces can be selected and measured like the part's.
- **STL** (`.stl`, binary or ASCII): a triangle mesh. It is shown and its **Body** measurements (volume, surface area, centre of mass, size) work; single faces and edges of a mesh cannot be measured, and no modelling feature can use a mesh. A mesh with holes or other bad edges encloses no volume, so its volume, centre of mass and mass show as none (hover over **Volume** for why); surface area and size still work.

An imported file becomes a **reference body**: it is shown next to the model and can be measured, but it is not joined to your part and is never exported with it. It is added to the document as an **Import** feature, one undo step: **Undo** removes it and hides the body, **Redo** brings it back. Once an undone import can no longer be redone (you made another change after the undo), the body is let go for good.

The file itself is stored inside the document, so the document stays complete on its own when it is saved or copied. Files up to 20 MB can be imported.

### Good to know

- Face names of an imported STEP body are numbered in the order the file lists them (`import#1:face:7`). A STEP file has no modelling history, so if you replace it with an edited version, the numbers may point at different faces. Anything that refers to an imported face is marked as fragile and warns you when it is resolved.
- Combining an imported STEP body with your part (cutting it out, adding it) is supported by the document and the geometry kernel, and becomes available in the app with the feature tree.
- Units: STEP files carry their units and are converted to millimetres on import. STL files have no units; like every slicer, manufakture reads them as millimetres.
