# Configurations

A configuration is a variant of the design: the same shelf board at 600, 800 and 1000 mm wide, a bracket with and without its fillet. The document keeps one model and a table of variants. Each row of the table names a variant and says what it changes; the rest of the model is shared. It works like the configurations of Onshape, for the two things a row can change here: the value of a [variable](variables.md) and whether a feature is suppressed.

## The Configurations panel

The **Configurations** panel is in the side panel, under Variables (like Variables, it steps aside while a sketch or a feature dialog is open). It has two parts: the parameters, which are the columns of the table, and the configurations, which are its rows.

### Parameters

A parameter is something a row can change. Choose one in **Add parameter**:

- **Variables**: every variable the table does not configure yet, like `#width`. A row gives it its own expression.
- **Features**: every feature of the part studio you are in, as **Suppress Fillet 1**. A row says whether that feature is suppressed.

A new parameter is named after what it changes (`width`, `Fillet 1 suppressed`); click the name to change it. **Delete** removes the parameter and every row's value for it; the model goes back to the document's own value.

### Configurations

**Add** at the top of the panel adds a configuration, named `Configuration 1`, `Configuration 2` and so on; click the name to change it (Enter applies, Escape goes back). Names must be different from each other.

Each configuration lists the parameters with its value for each:

- a variable takes an expression, typed like any number field: `800`, `#depth * 2`, `1/2"`. As in the Variables panel, a plain number for a length or angle gets its unit written in (`800` becomes `800 mm`). The value is applied when you press Enter or leave the field; if it is wrong (an angle where the variable is a length, an unknown variable), it is shown under the field and not applied.
- a suppression is **Suppressed**, **Not suppressed**, or **As modelled**.

An empty value (or **As modelled**) keeps the document's own value, shown under the field: a new parameter needs no value in every row.

**Show** builds and shows the model in that configuration (the shown one is marked **Shown**); **Delete** removes the configuration.

Every change in the panel, including which configuration is shown, is one step for Undo.

## Switching configurations

When the document has configurations, the header has a **Configuration** list. Pick one to rebuild the model in it: the viewport, measurements, the feature tree's results and exports all follow. **None (as modelled)** shows the document with its own values, as if there were no table.

The Variables panel marks a variable the table configures as **Configured**. When the shown configuration changes a variable, directly or through one it reads, the panel says what it is in that configuration: `In 800: 800.00 mm`. The variable's own expression, which you edit in the Variables panel, stays the value for rows that do not set one.

If the shown configuration cannot be applied (a value that no longer works after an edit), the panel says so, and the model is built without it until the value is fixed.

## Exporting every configuration

To get a file of each variant at once, open **Export**, tick **Every configuration**, and pick **3MF**, **STL** or **STEP**. Each configuration is rebuilt in turn and written to its own file, named `<document>-<configuration>`, for example `Shelf-600.3mf`, `Shelf-800.3mf`, `Shelf-1000.3mf`. The files download one by one as they are made.

The header shows the progress (`Exporting configuration 2 of 3 (800)...`) with a **Cancel** button; cancelling keeps the files already made. When it is done the model goes back to the configuration you had shown.

Which bodies are written follows the [Export menu](import-export.md): the bodies ticked there, and hidden bodies are left out. A configuration in which a feature fails, or in which there is nothing left to write, is skipped and named in the message; the others are still exported. **STL, one file per body** is not offered for every configuration, since each configuration gives one file.

## Deleting or inlining a configured variable

A variable a parameter configures is in use, so it cannot simply be deleted. The Variables panel offers to replace its uses with its value, and warns first that the table configures it: replacing it deletes the parameter and every configuration's value for it, so every configuration then gets the document's own value. The button says so too (**Replace with value, delete it and its parameter**). Undo brings the variable, the parameter and the values back.

A feature a parameter suppresses cannot be deleted until that parameter is deleted.
