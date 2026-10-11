# Mechanical: machines that move and carry load

> **Placeholder wording.** This notice and its short form were drafted for M9 (ADR 0017, decision 17). The maintainer may reword both at M9 acceptance (task #1269); until then they say what the software does, in draft.

The short form, shown wherever mechanical output appears:

> manufakture calculates by the methods and inputs shown in each record; it does not certify a design as safe or compliant with any standard. Catalog data is typical and unverified unless marked. Have a qualified engineer review any machine that carries load or stores energy before building or using it. Provided without warranty under GPL-3.0-or-later.

## Calculates, never certifies

manufakture calculates how a machine you design behaves: forces, torques, speeds, currents, temperatures, stresses, deflections, bearing life and battery energy. It shows how it got every number. It does not decide whether your machine is safe.

- **Every number shows its working.** Each result is a calculation record that names its method, its formula, every input and where that input came from, its assumptions and its published source. A result is only as good as its inputs and its method's assumptions.
- **Margins against your factors, not verdicts.** Strength and life are reported as a value and a factor against a safety factor you chose ("von Mises 182 MPa, yield 415 MPa, factor 2.28 against your 2.0"). Below your factor is a warning. Choosing the factors is your engineering judgement; manufakture ships none.
- **Targets are yours.** Against requirements you set, results say "meets" or "misses" and by how much. A design that meets every requirement is not thereby safe.
- **No certification and no compliance check.** Nothing manufakture shows or exports means that a design is safe, certified, or compliant with a standard or a regulation. Where it names a standard (such as ISO 20957, IEC 60335, IEC 62133 or UN 38.3), it is a place for you to look; no text of any standard is shipped or used.
- **Catalog data is typical and unverified unless marked.** Part ratings come from published datasheets and are marked unverified until someone checks them against the maker's current document. Datasheets differ in their conventions and change between editions; check the parts you buy.
- **The models have limits.** The hand calculations are textbook methods, exact only for their stated assumptions. The simulation is a lumped model with one degree of freedom. Stress analysis is linear, elastic and isotropic: it does not model the layers of a printed part, the grain of wood, contact, large deflections or cracks, and stresses at sharp corners and point supports grow without limit as the mesh is refined. The absence of a warning says nothing about a design.
- **Load and stored energy can hurt people.** A machine that carries load or stores energy (a cable under tension, a raised mass, a spinning rotor, a spring, a battery) can injure when it fails. Have a qualified engineer review it before you build or use it, and test the built machine as its verification test plan describes, with guards in place.

manufakture is free software under the GNU General Public License, version 3 or later (see [LICENSE](../../LICENSE)), and comes with no warranty, to the extent permitted by applicable law; sections 15 and 16 of the license say so in full. This page describes what the software does; it is not legal advice.

A short form of this notice appears in the mechanical panels, on every specification, on every diagram and schematic sheet, in every BOM, harness and netlist export, and in the results of the mechanical MCP tools.

## Getting started

The mechanical tools live in the part studio, in the **Mechanical** group of the feature toolbar. A document starts with no mechanical settings. **Mechanical** asks, the first time, for two safety factors:

- a **strength factor on yield**, which strength checks compare against, and
- a **fatigue factor**, which fatigue and life checks compare against.

Both are optional, and nothing is filled in for you. A check with no factor shows its value and the factor it reaches, with nothing to compare it to and no warning ("factor 2.28; not compared: no factor set"). You can set or change either factor later from the same button. Leaving a field empty takes that factor away again.

## What a document stores

Mechanical content is stored in the document's `mech` section, which only exists once you use it, so documents that do not use the mechanical tools are unchanged by it:

- **Requirements**: named targets, each a quantity with a comparison and an optional tolerance (`maxForce >= 200 lbf`, `peakCableSpeed >= 2 m/s`, an envelope within 300 x 200 x 150 mm).
- **Load cases**: what the machine sees, a repetition profile with a resistance mode (constant, eccentric, band, chains, isokinetic, damper, rowing, isometric or a table) and static loads (a side pull, a point load, a drop as an acceleration).
- **Drivetrains**: a chain of stages from the motor to the output (belts, gears, shafts with bearings, couplings) ending in a spool, a rotary or a linear output.
- **Purchased parts**: catalog entries used in the design, with alternates, and your own catalog entries.
- **The electrical system**: components, the connections between their terminals and harness segments, with manual nudges of the diagram layout.
- **Schematics** of boards in the electrical system, with your own symbols.
- **Stress studies**: fixtures, loads and mesh settings on the faces of a part.
- **What you add to checks and specifications**: per-check factors and inputs (a bolt's preload, a fit class), specification notes, hazards and verification test bands.

Values are typed with units, as everywhere else: `200 lbf`, `22 N*m`, `2 m/s`, `25degC`. A physical value always needs its unit; a bare `200` in a force field is refused, so a stored value never depends on a display preference. Values may use variables, so "the spool radius that meets the force target" can be a variable you tune.

Display units can be chosen per kind (newtons or pound-force, N·m or lbf·ft); a kind without a choice follows the document's length unit, SI for millimetres and metres, US customary for inches and feet.

## Purchased parts

A purchased part (a bearing, a belt, a motor, a cell, a fuse) is a catalog entry: a family, the maker and part number, the ratings the family's datasheets state, the dimensions, the mass, where the numbers came from and whether you checked them. **Parts** in the part studio's toolbar opens the catalog: a few built-in sample entries with typical published values, and your document's own entries.

- **Add from a datasheet** types an entry in field by field. Ratings take units (`5.4 kN`, `17000 rpm`, `8 kHz`); a bare number is in the unit shown next to the field, your display unit for that kind. A frequency field refuses `rpm`: write `Hz`. Write `unknown` for a value the datasheet does not give. Fields whose value depends on a convention (a motor's Kv and Kt, a winding resistance) ask which one; ratings that depend on test conditions (a continuous current, a belt's working tension) ask for the conditions.
- **Import CSV** adds many entries at once. The first row names the columns: `family`, `maker`, `partNumber`, `description`, `mass`, `verified`, `notes`, `shape`, `axis`, `sourceTitle`, `sourceUrl` (http or https only), `sourceRevision`, `sourceRead`, `dim.<name>` for a dimension and the family's rating names (with `<rating>.convention`, `.basis` and `.estimated`). A file with any malformed row is refused as a whole, with the line of each problem; nothing is imported until every row is good.
- An entry can carry a **STEP file** for its geometry. Without one, placing it builds a **placeholder**: a ring, a cylinder or a box from its dimensions.
- **Place** adds a part studio holding the geometry (the STEP file as a reference body, or the placeholder) and records the part as used; with an assembly chosen, it also puts an instance in it.

The **bill of materials** lists each part used with its quantity (the instances in the assembly it is counted through, or a typed quantity for parts not modelled), its alternates and the ratings the design relies on: "C at least 5100 N; n at least 3000 rpm". Until the checks say what each part must carry, those are the chosen part's own values, so a substitute must match them. The BOM is saved as CSV here and in `bom-csv`. Catalog data is typical and not verified unless you mark it: check the maker's current datasheet.

## Requirements and load cases

**Requirements** in the part studio's toolbar opens your targets and the load cases the machine sees.

- **Requirements** are a table: a name, a quantity (maximum or minimum force, force step, peak cable speed, travel, hold duration, sessions per charge, charge time, pack energy, mass, envelope, surface temperature), a comparison, your target and an optional tolerance. A requirement can name the load case it is about: the speed at full force is measured in the full force rep, the sessions per charge in a session. An envelope takes three sizes and is always "within". **Save requirements** checks every value (a force target must be a force, `200 lbf`; a size must be above zero) and names the row and field of each problem; nothing is saved until all of them read. Results against requirements say "meets" or "misses" and by how much; they are your targets, so meeting all of them does not make a design safe.
- **Load cases** are listed by name; choose one to edit it or **New load case** to add one. A load case has a **resistance mode** (the force law), a **force**, a **motion** and a **duty cycle**:
  - **Constant**: the same force out and back.
  - **Eccentric**: the force on the pull and the force times a factor (at least 1) on the return, so more force on the way back.
  - **Band**: the force plus a rate (`200 N/m`) times the extension.
  - **Chains**: the force, plus a rate times the extension beyond where the chains leave the floor.
  - **Isokinetic**: the cable goes no faster than a speed limit; the force is felt only at the limit, none below it.
  - **Damper**: a coefficient (`100 N*s/m`) times the speed on the pull, up to the force.
  - **Rowing**: a coefficient (`25 N*s^2/m^2`) times the speed squared on the pull, up to the force, as a fan does.
  - **Isometric**: the force, held at mid-stroke for a duration.
  - **Table**: your own force curve, by extension or by speed, typed one point per line in metres or metres per second and newtons (`0.3, 450`), straight between points and flat beyond the ends, up to the force.

  Extension is measured from where the rep starts; on the return the speed counts as negative. The damper and rowing modes give no force on the return; the take-up tension that keeps the cable wound belongs to the drivetrain.

- **The motion** is a rep (pull over the stroke with a half-cosine whose peak is the pull speed, a pause, the return peaking at the return speed, a pause) or a table of time and extension. The isokinetic limit slows any move that would go faster.
- **The duty cycle** is reps per set, sets and the rest between sets, with the charge at the start (a fraction, 1 for full) and the ambient temperature when they matter. The editor states how long a rep, a set and the session take.
- Each load case's law is **plotted** from the law itself: force against extension (pulling and returning at the motion's speeds) and force against speed (at mid-stroke; below zero is the return). Static loads (a side pull, a drop as an acceleration) are kept as they are when you edit a load case.

**Templates** fill in a starting set for you to change: a **cable trainer**, whose targets come from the published specifications of comparable machines and a few estimates (5 to 200 lbf in 1 lbf steps, 2.85 m of travel, 1.5 m/s at full force and 3 m/s for light rowing, a 30 s hold at 200 lbf at 40 °C, 6 sessions of 13 sets of 9 reps at 100 lbf and 14 at 60 lbf per charge, a pack under 100 Wh charged within 2.5 h, at most 6 kg in 330 x 140 x 100 mm, touchable surfaces at most 60 °C, an estimate to replace with your limit), a **winch** and a **linear axis** with example targets. A template is added to what the document already has, in one undo step. No template fills in a safety factor. Targets a requirement cannot state yet (force accuracy, the fault response, the parts' own limits) are left to the checks and the control specification.

## Drivetrain

**Drivetrain** in the part studio's toolbar opens the chain from the motor to the output: what turns, how fast and with what inertia. A design may have several drivetrains, each its own chain.

- A drivetrain names an **assembly**; its stages name the instances in it. Stages go **in order from the motor**: the motor first (a purchased motor, optionally its instance and the revolute mate its shaft turns on), then belts, gear pairs, planetaries, shafts and couplings, in the order power flows. The **output** is a spool (its instance and body, the cable and its length), a rotary output or a linear screw (lead and efficiency).
- A **ratio** is input speed over output speed, so a 5:1 reduction is `5`; or type the tooth counts and the ratio is driven over driver (15 to 75 teeth is 5). Each reduction has one **efficiency**, from 0 to 1.
- **Inertia** comes from what you type on a stage (`4e-5 kg*m^2`, `20 g*cm^2`), else the motor's catalog rotor inertia, else the kernel's measurement of the instance the stage names, from its bodies and their materials. A reduction's typed inertia is referred to its input, as gearbox datasheets give it. A gear or planetary stage measures its input member at the input speed and its output member at the output speed. A belt's pulleys count only when you type their inertia. A measured part is taken to turn about its axis of symmetry (the axis of a spool or a shaft). Anything with no inertia at all counts as zero, and the working says so. An instance of a part from another document is not measured: type its inertia.
- The panel shows the **overall ratio** and **efficiency**, each turning element with its speed, inertia and where it came from, and the **inertia reflected to the motor** (each element's inertia divided by the square of its speed ratio) and **to the output**. **Working** shows each record's method, formula and assumptions.
- Type a **torque and an acceleration at the output** to get the **motor torque**. A positive acceleration speeds the motion up in its own direction; a slowing motion is negative. When the motor drives the output, the motor torque is in the direction of motion and the efficiencies divide; when the output drives the motor (the user pulling the cable out while the motor resists), the motor torque is against the motion, the efficiencies multiply, and what the parts need to speed up is taken from the user's torque before it reaches the motor. For example, 22.25 N·m at the spool through a 5:1 belt at 0.95 needs 22.25 / (5 x 0.95) = 4.68 N·m at the motor when driving, and gives 22.25 x 0.95 / 5 = 4.23 N·m when back-driven at a steady speed.
- A gear or planetary member that is fixed in the assembly (a held ring) does not turn and is not counted; for planets or a turning ring, type the stage's inertia. A part with no clear axis of symmetry is measured about a guessed axis, and the working says so. For a **linear output** (a screw) the numbers stop at the screw shaft: its lead and efficiency, its inertia and the mass it carries are not included yet, and the working says so.
- A stage that names an instance, mate, purchased part or body that is no longer there is listed in the panel and as a warning in an agent's `get_errors`; the numbers that need it say what is missing. The Drivetrain button shows how many problems the drivetrains have: these, and values that do not read or a chain that does not start at its motor (which only an agent or an older file can store; the panel refuses to save them).

## Spool and cable

When a drivetrain's output is a **spool**, the Drivetrain panel also shows how the cable winds on it, and so what the motor sees at every extension.

- Choose the **cable** from your purchased parts (a rope or cable entry: its diameter, breaking loads, bend ratios, elongation and mass per length come from the catalog), and type the **cable length** on the spool, the **core diameter** and the **width between the flanges**. The **flange diameter** can be typed, or left empty to read it from the spool body: the app measures the body and takes its outside diameter (the body has to turn about one of its part's axes). The core and the width are inside the body, where the measurement cannot see, so they are always typed.
- The cable winds in layers. Each layer holds as many turns as fit across the width (the width divided by the cable diameter, rounded down), and each layer sits one cable diameter further out than the one below (simple stacked winding, the usual hand calculation; real winding nests a little, so these radii are the largest it can be). The cable comes off the outermost layer first, so the **effective radius** steps down one cable diameter each time a layer empties: largest at zero extension, smallest at full payout.
- Torque at the spool is the cable tension times the effective radius, and spool speed is the cable speed divided by it, so both change with extension. For example, 2.85 m of 3 mm cable on a 40 mm core, 20 mm wide: 6 turns a layer, 4 layers, 30.5 mm at zero extension and 21.5 mm at full payout. At 890 N that is 27.1 N·m wound and 19.1 N·m out, a change of 42 % over the stroke. When you have a maximum force or peak cable speed requirement, the panel shows the torque and the spool speed (in rad/s and rpm) beside both effective radii.
- **Flange clearance** is how far the flanges stand above the top layer. It is compared with 2 cable diameters, a common winch drum rule of thumb; below that, and especially below zero (the cable rides over the flange), it shows a warning.
- **Bend ratio** D/d is the diameter the cable bends round over the cable's diameter, at the core and at a fairlead or pulley if one is set. It is compared with the rope's minimum bend ratio from its catalog entry, and the suggested ratio is shown beside it. A 3 mm fibre rope on a 40 mm core is 13.3, above the 8 minimum and 10 suggested of braided HMPE; a steel cable wants 34 or more.
- **Cable length** is compared with your **travel** requirement (the whole length is taken as usable: keep a few turns on the core and the length to the fairlead in mind). **Stretch** at full payout under the maximum force comes from the rope's elongation figure, taken as proportional to load. Fibre ropes stiffen as the load rises, so this straight-line estimate is low below the load the catalog figure was measured at and high above it.
- Problems with the spool itself are listed with the drivetrain's and counted on the Drivetrain button: a cable length or diameter that is not above zero, a cable that is not a rope or cable entry, a flange smaller than the core, or a width longer than the spool body as measured. The panel refuses to save the ones it can see before a regen.
- The spool shows numbers and margins only. Whether the cable is strong enough is the cable tension check, against the strength factor you set; nothing here says a spool or cable is safe.

## Checks

Every time the design regenerates, the checks run on it and each one makes **records**: one number with its working. **Checks** in the part studio's toolbar lists them (with a count of the ones to look at), each with one line that states the numbers ("Cable tension, Rope in Hold: load 890 N, rated load 4.50 kN; factor 5.06, above your 2"). **Working** shows how it was computed: the method and formula, every input with its value and where it came from (a load case, a catalog field, a measured body, the simulation, your setting or override), the values derived on the way, the assumptions and the published sources.

- A strength or life result is a **factor against yours**: "above your 2" or "below your 2". Below your factor is a warning. With no factor set, the factor is shown with nothing to compare it to, and there is no warning.
- A record that could not be computed says so and **names what is missing** ("Missing: Peak cable tension (no simulation of lc#4 has run)").
- Records below your factor or not computed also appear as warnings in an agent's `get_errors`, with the record and check ids.
- **Per-check factors and inputs** live in the document as check overrides: one for a single check (`cable.tension`) or a family (`cable.`), for every subject or for one (a load case, a part). The most specific one applies; an override's factor that does not evaluate makes the record "not compared" rather than quietly dropping the comparison.

Records are never saved; they are recomputed from the document, and only the ones whose inputs changed are computed again. The first check is the cable's tension against the rope's minimum breaking load, for each load case that pulls the cable; the shaft, bearing, bolt, gear and belt, electrical, thermal and stability checks follow.

## Your own materials

Besides the built-in materials, a document can hold materials of its own, with a density and any of the mechanical and thermal properties (elastic modulus, yield and ultimate strength, endurance limit, conductivity, maximum service temperature and more), each with its source and whether it is a typical value. Material values are constants with units (`1240 kg/m^3`, `45 MPa`); a variable is refused, because a material is a library entry. Parts and bodies can use them like the built-in ones; a material in use cannot be deleted.
