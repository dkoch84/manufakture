# Sharing

You can share a model with someone who does not use manufakture, or who should look but not edit: publish a **view** of it. A view is one file holding what the viewport shows, as triangle meshes with the names of their faces and edges, and what you set on the bodies (names, colours, materials) with their volumes and masses. It opens without the geometry kernel and without the editor.

Everything here works offline: publishing is done in your browser, from the model already on screen, and nothing is sent anywhere.

## Publishing a view

1. Open the part studio or the assembly you want to share.
2. Click **Export** in the header.
3. Tick **Include source** if the person you share with should also get the document itself (see below).
4. Click **Publish view (.mfkview)**.

The file downloads straight away, named after the part studio or the assembly, with the extension `.mfkview`. The header says what was published and how big the file is. A small part is a few kilobytes: the M1 bracket is about 6 KB.

What goes in:

| You are in    | The view holds                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a part studio | the bodies that are shown (hidden [bodies](bodies.md) are left out), each with its name, colour, material, volume and mass                              |
| an assembly   | each part once and every instance where the last solve placed it, named as in the assembly; suppressed instances and instances that failed are left out |

- **Meshes** are the ones the viewport draws, so curved faces are as smooth as they look on screen. The view is for looking and measuring roughly, not for manufacturing: export STEP or 3MF for that (see [Importing and exporting](import-export.md)).
- **Volumes** are exact (the kernel's, as the [Measure](measure.md) tool gives them) where the kernel has the body, else worked out from the mesh. **Masses** are the volume times the material's typical density, so a body without a material has none.
- **Positions** in an assembly are those of the last solve: a drag still going on, or an exploded view, is not published.
- **Names** of faces and edges are the ones features give them; faces with only a temporary name in the viewport are published without one.

### Include source

With **Include source** ticked, the view also carries the document as a `.mfk` file, the same kind of file a document's **Export** on the home screen saves (see [Files](files.md)), as it is on screen and without its named versions. Whoever receives the view can then import the model into manufakture (the `source.mfk` inside the zip, through **Import .mfk**) and edit their own copy. Leave it unticked to share only what the model looks like: the view then holds no sketches, features, variables or history, only the meshes and the metadata above.

## Opening a view

A view is an ordinary zip file. Inside, each body is a standard binary glTF (`.glb`) file, which most 3D viewers and tools open (Blender, online glTF viewers, Windows 3D Viewer), and `manifest.json` lists the bodies, parts and instances in plain text.

A viewer page that opens `.mfkview` files in the browser, from a file or from a link, is coming, and so are share links that publish a view and copy a link to it in one step. This page will say how to use them when they arrive.

## Safety

A view you receive is untrusted, and the viewer will treat it so: manufakture's reader takes only the entries the format defines, checks every field and every mesh against strict limits before anything uses it, and hands names on as plain text to be shown as text. A file that is damaged, too large or not a view is refused with a message saying why. A source `.mfk` inside a view is checked again, like any `.mfk` you import, when it is opened.
