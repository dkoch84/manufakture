# Variables

A variable is a named value, such as `#thickness`, that any number in the part can use. Change the variable once and every dimension, depth and radius that reads it follows. It works like the variables of Onshape: type `#` and the name wherever a number goes.

## The Variables panel

The **Variables** panel is at the top of the side panel (it steps aside while a sketch or a feature dialog is open). Each variable shows:

- its name, like `#w`, and its value in the document's display units (`40.00 mm`, `1' 3-3/4"`, `30.00°`);
- the expression it is defined by, and its type: **Length**, **Angle**, **Number** or **Any**;
- where it is used: **Used in 2 places** opens the list (`#h`, `Sketch 1: dimension k4`, `Extrude 1: Depth`). Click a feature in the list to select it in the tree.

**Add** opens an empty row; **Edit** (or a double-click on the row) opens a variable to change it. Fill in:

- **Name**: letters, digits and `_`, starting with a letter or `_`. Names are case sensitive. The names of functions and constants (`sin`, `sqrt`, `pi`) cannot be used. A leading `#` is dropped.
- **Type**: what the value is. A length variable must come to a length, an angle variable to an angle, and a number variable to a plain number (a count, a ratio). **Any** takes whatever the expression gives, such as an area (`#w * #d`).
- **Value**: an expression, like every numeric field (see below). It may use other variables: `#d - 10`, `#width / 3`.

**Add** or **Save** (or Enter) applies it; **Cancel** (or Escape) leaves the table as it was. Each change is one step for Undo.

### Bare numbers get their unit

A plain number typed for a length or angle variable gets the unit written in: `40` becomes `40 mm` in a millimetre document, `40 in` in an inch or feet-and-inches document, and `45` becomes `45 deg`. An expression without units gets parentheses: `2 * #n` becomes `(2 * #n) mm`. This keeps the variable's meaning fixed: a length is a length in every field that reads it, whatever units that field was typed in. Expressions that already come to a length or angle (`25 mm`, `#d - 10`, `3' 4-1/2"`) are kept exactly as typed.

### Variables that read each other

A variable may read others, but never itself, directly or round a loop. Typing one that would makes the problem show at once, under the value, for example:

> Variables cannot read each other in a loop: #w -> #a -> #w.

It cannot be saved until the loop is broken.

### Renaming

Changing the name of a variable renames it everywhere: in the other variables and in every feature and sketch dimension that uses it, as one step for Undo. References are rewritten as `#newname`.

### Deleting

**Delete** removes a variable nothing uses. A variable that is in use cannot simply be deleted: the panel lists where it is used and offers **Replace with value and delete**, which writes the variable's current value into each use (`#h` becomes `20mm`, and `#d - 10mm` becomes `(25mm) - 10mm` inside a larger expression) and then deletes it, as one step for Undo. The part does not change, since every use keeps the same value. **Keep it** closes the offer.

## Numbers in fields

Every numeric field (the feature dialogs, the sketch dimension box and the Variables panel) takes the same expressions:

- numbers with units: `12`, `12.5 mm`, `1/4"`, `3' 4-1/2"`, `30deg`;
- arithmetic: `+ - * / ^`, parentheses, and functions like `min`, `max`, `sqrt`, `round`;
- variables: `#thickness`, `2*#t + 1/8"`.

A plain number is in the document's units (inches when the document shows feet and inches, or inch fractions). Under the field you see what the expression comes to in the display units, or what is wrong, with the part of the text at fault highlighted: an unknown variable, a length where an angle is needed, or a syntax error such as a missing `)`.

### Completing names

Type `#` and a list of the document's variables opens under the field, each with its value. It narrows as you type: a name typed in full comes first, then names that start with what you typed, then names that contain it. When the name is typed in full and nothing else matches, the list stays closed, so Enter goes straight to the dialog.

- **Down** and **Up** move through the list.
- **Enter** or **Tab** puts the highlighted name in the field.
- **Escape** closes the list; the next Escape (or Enter) goes to the dialog as usual.
- A click on a name puts it in too.

While the list is open, Enter and Escape belong to it, so they never apply or close the dialog by accident.

## When a variable changes

Changing a variable rebuilds only what reads it, directly or through other variables, and what is built on that. Changing the depth of an extrusion leaves its sketch as it was (taken from the cache) and rebuilds the extrusion and the features after it; changing a sketch dimension rebuilds the sketch too. The feature tree shows the new state as soon as the rebuild is done.
