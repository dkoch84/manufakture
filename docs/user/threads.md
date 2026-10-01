# Threads

**Thread** puts a screw thread on a round face: an external thread on a shaft (a bolt, a thumbscrew), an internal one in a hole (a nut, a tapped boss). Pick the round face, choose a size, and the thread is cut into the part. It is one feature in the [feature tree](feature-tree.md), which shows its size after the name (`M6`, `1/4-20 LH, cosmetic`), and it changes only the body that owns the face.

## Making a thread

1. Model the shaft or the hole at about the right size: a shaft at the nominal diameter (6 mm for M6), a hole at the tap drill (5 mm for M6) or at the minor diameter (4.917 mm for M6). The thread defines the geometry, not the cylinder's exact size, so anything in the size's range works.
2. Click **Thread** in the feature row and pick the round face in the 3D view (or pick it first, then click **Thread**). The dialog says what it found: `A shaft 6 mm across: an external thread`.
3. **Size** lists only the sizes that can be cut into that face, and starts on the one it was most likely made for. **Standard** switches between ISO metric coarse (M2 to M20) and UNC (#4 to 1/2").
4. Set the length, the hand, the clearance and the representation (below), then **OK**.

| Field              | What it does                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cylinder**       | The round face to thread. A shaft gets an external thread, a hole an internal one.                                                                                                                                                                                                                |
| **Standard, Size** | ISO metric coarse or UNC, and the size: `M6 x 1`, `#10-24`, `1/4-20`.                                                                                                                                                                                                                             |
| **Whole length**   | Thread the whole face. Untick it to give a **Length**, measured from the start.                                                                                                                                                                                                                   |
| **Start edge**     | Optional: a round edge at the end the thread starts from. Without one, it starts at the end where the face's first neighbour by name is (a lone extruded shaft's top, its `cap:end`; on a bolt, the head end), and a thread shorter than the face grows from there. Pick an edge when it matters. |
| **Hand**           | Right hand (the usual) or left hand.                                                                                                                                                                                                                                                              |
| **Clearance**      | How much smaller (a shaft) or larger (a hole) across the thread is than the standard's basic size, so printed parts screw together. See below.                                                                                                                                                    |
| **Representation** | **Modelled** cuts a real thread; **Cosmetic** only resizes the cylinder and draws the thread.                                                                                                                                                                                                     |

## Clearance for printed threads

Printed threads need room to turn, just like a printed peg in a hole. The **Clearance** is diametral, like the [fit variables](fits.md): the thread is that much smaller across on a shaft, larger in a hole. With the fit variables in the document (**Insert fit variables** in the Variables panel), it starts as `#fit_slip`; without them, as 0.2 mm. A bolt and a nut each threaded with `#fit_slip` (0.2 mm) end up 0.2 mm apart between crest and root and about 0.1 mm apart across the flanks, so they turn without binding. Change `#fit_slip` after printing the fit-test coupon and every thread that uses it follows.

The clearance is part of the range check: a larger clearance lets a size fit a slightly smaller hole, and the other way round.

## Modelled and cosmetic

- **Modelled** threads are real geometry, ready to print: the helical groove is cut into the shaft or the hole. Where the cylinder ends freely (a shaft's tip, a hole's mouth in a face of the part), the thread runs out through the end with a 45 degree chamfer, so the first turn prints without a feather edge. Where it meets something (a bolt's head, a blind hole's bottom), or where the thread is shorter than the face, it stops with a flat end, short of the rest of the part. A modelled thread takes about a second to build per 20 mm of M6; it rebuilds only when it or the faces before it change.
- **Cosmetic** threads leave the thread out and only resize the cylinder: a hole to the tap drill (5 mm for M6), a shaft to the major diameter less the clearance (5.8 mm for M6 with a 0.2 mm clearance). Use them for holes you tap after printing, for self-tapping screws and heat-set inserts, or to keep a part with many threads quick to rebuild. The thread is drawn as a helix over the face, with a circle at each end of it.

Switching between the two keeps every other setting. The face the thread was picked on stays the thread's own reference either way, but the threaded side of the cylinder gets a new name: a feature after the thread that picked that side (a chamfer on its rim, say) loses its reference on a switch, and the tree asks for it again.

## Bolts and nuts

Two threads of the same size and hand on the same axis always mate, wherever each one starts: the helix follows the axis line, not the end of the face. So a bolt and a nut threaded on their own, in one part or in two, fit together where they are modelled, and an assembly's **Interference** check finds nothing between them. In one part studio, model them as two bodies (the nut a **New body**): the bolt's thread cuts only the bolt, even where the nut sits on it.

## When a thread fails

- **A size that does not fit**: the face is too big or too small for the chosen size. The error names the range, for example `M6 (external) needs a shaft 4.988 to 8 mm across; extrude#2:side:e2 is 10 mm`. Pick another size, or change the cylinder.
- **Not a round face**: the picked face is flat or curved some other way. Pick the cylinder itself.
- **Longer than the face**: the length runs past the end of the face. Shorten it, or tick **Whole length**.
- **The face is gone**: an edit upstream removed or renamed the face. The tree offers to pick it again, as for any feature.

A thread that cannot be built still stays in the tree with a red cross and its reason; the part passes through it unchanged until it is fixed.
