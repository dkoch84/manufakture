# Fits for printed parts

A printed peg rarely fits a printed hole of the same size. The printer squeezes plastic a little wider than the model, holes come out small and pegs come out large, so two printed parts that should slide together need a gap between them: the **clearance**. How much depends on what the parts must do:

| Fit         | Variable       | What it feels like                           | Default (0.4 mm nozzle) |
| ----------- | -------------- | -------------------------------------------- | ----------------------- |
| **Press**   | `#fit_press`   | goes in with force and stays                 | 0.10 mm                 |
| **Slip**    | `#fit_slip`    | slides in by hand without play               | 0.20 mm                 |
| **Sliding** | `#fit_sliding` | moves freely (a hinge pin, a sliding drawer) | 0.40 mm                 |

Clearances here are **diametral**: the hole is the peg's diameter plus the clearance. A 6 mm peg with a slip fit goes in a hole of `6 mm + #fit_slip`, 6.2 mm by default.

**The defaults are starting points, not measurements.** They are typical values people use for FDM printers with a 0.4 mm nozzle; nobody has measured them on your printer yet. Real clearances depend on the printer, the nozzle, the filament and the slicer's settings. One example: OrcaSlicer's Bambu Lab process profile for 0.20 mm layers (`fdm_process_single_0.20.json`, OrcaSlicer 2.4.2) sets **elephant foot compensation** to 0.15 mm, which shrinks the first layer inward and changes how the bottom of a hole fits. Print the [fit-test coupon](#the-fit-test-coupon) once with your own printer, filament and profile, and put what you measure in the variables.

## Insert fit variables

In the **Variables** panel, **Insert fit variables** adds `#fit_press`, `#fit_slip` and `#fit_sliding` to the table, all three in one step for Undo.

- The values come from a print setup's printer and nozzle: the setup open in the [Print workspace](printing.md), or else the document's first setup. Every Bambu Lab printer shares the same defaults for now; a 0.2, 0.6 or 0.8 mm nozzle scales them in proportion to the nozzle (0.15, 0.3 and 0.6 mm at 0.6 mm). A document with no print setup gets the 0.4 mm defaults. The message under the button says which it used.
- A variable that is already in the table is **never overwritten**: only the missing ones are added. Pressing the button again when all three exist changes nothing. So once you have put your measured values in, inserting again is harmless.

They are ordinary variables: edit them in the table like any other, use them in any expression (`#peg_d + #fit_sliding`, `#fit_slip / 2` for a radius), and every feature that reads them follows when you change them.

When you type `#` in a hole's diameter or head diameter, or in an assembly mate's offset, the completion list offers the fit variables first.

## Printed fits in the hole dialog

Next to the ISO 273 clearance fits (**Close**, **Normal**, **Loose**), the hole dialog's **Fit** list offers **Printed fit: press**, **slip** and **sliding** once a **Size** is chosen. A printed fit writes the diameter as the screw's nominal size plus the fit variable: an M3 with a slip fit is `3 mm + #fit_slip`. Insert the fit variables first; until then the dialog says the variable is missing and the diameter does not evaluate.

Editing the hole later shows the same size and printed fit again. Change the diameter by hand and it becomes a custom hole.

## Heat-set inserts and self-tapping screws

`packages/print` also holds hole sizes for M2 to M5 (`HEAT_SET_INSERTS`, `SELF_TAPPING_HOLES`); the app does not offer them in a dialog yet, so type the diameter yourself:

| Size | Heat-set insert hole (CNC Kitchen, standard length) | Insert length | Min. wall | Self-tapping hole (unverified) |
| ---- | --------------------------------------------------- | ------------- | --------- | ------------------------------ |
| M2   | 3.2 mm                                              | 3.0 mm        | 1.3 mm    | 1.6 mm                         |
| M2.5 | 4.0 mm                                              | 4.0 mm        | 1.6 mm    | 2.05 mm                        |
| M3   | 4.0 mm                                              | 5.7 mm        | 1.6 mm    | 2.5 mm                         |
| M4   | 5.6 mm                                              | 8.1 mm        | 2.1 mm    | 3.3 mm                         |
| M5   | 6.4 mm                                              | 9.5 mm        | 2.6 mm    | 4.2 mm                         |

The insert holes are CNC Kitchen's own table for their standard inserts (read from the product pages on 2026-10-01); other brands differ, so use your insert's table. The self-tapping holes are **not verified**: they are the metric tap drill sizes (nominal minus pitch), a starting point for a screw cutting its own thread in plastic. Print a test.

## The fit-test coupon

On the Documents screen, **New fit-test coupon** makes a new document to measure your fits. It has two plates in one part studio:

- the **hole plate**, 120 x 20 x 6 mm, with a row of eleven holes. Their diameters are `#peg_d` (6 mm) plus a clearance that grows by 0.05 mm per hole: hole 1 has +0.00 mm, hole 2 +0.05 mm, up to hole 11 with +0.50 mm. Each hole's name in the feature tree says its clearance (**Hole 4: +0.15 mm**);
- the **peg plate**, 50 x 15 x 3 mm, with three pegs of diameter `#peg_d`, 10 mm tall.

The holes are not labelled on the part yet (labels come with text, in a later version). Instead a small **marker hole** sits in the corner next to **hole 1**: count from the marker.

| Hole      | 1    | 2    | 3    | 4    | 5    | 6    | 7    | 8    | 9    | 10   | 11   |
| --------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| Clearance | 0.00 | 0.05 | 0.10 | 0.15 | 0.20 | 0.25 | 0.30 | 0.35 | 0.40 | 0.45 | 0.50 |

The document comes with a print setup for a Bambu Lab X1 Carbon with a 0.4 mm nozzle. To test another peg size, change `#peg_d`; the pegs and every hole follow.

### Procedure

1. Print both plates flat, as modelled, in the filament and with the slicer profile you use for real parts. Let them cool.
2. Take a peg and try it in each hole, starting at hole 1 (next to the marker). Hold the peg plate at right angles to the hole plate so only one peg meets the row: the pegs are 15 mm apart and the holes 10 mm, so held parallel, the other pegs land on solid plate. Push from the top side of the plate: the bottom of each hole is affected by the first layer.
3. **Press**: the first hole where the peg goes in with force and stays.
4. **Slip**: the first hole where the peg slides in by hand without play.
5. **Sliding**: the first hole where the peg moves freely.
6. In your own documents, set `#fit_press`, `#fit_slip` and `#fit_sliding` to those holes' clearances (from the table above, or the feature names). If no hole is tight enough for a press fit, the press clearance is below 0 for that printer: try `0 mm` and print a test of the real part.

One printer and one spool are one data point; a new filament or a changed profile may need a new coupon.
