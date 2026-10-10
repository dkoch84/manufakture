# Materials

A part, or a body of it, can be given a material: in the [Measure panel](measure.md) for the whole part, or in the Bodies list of the feature tree for one body (see [Bodies](bodies.md)). The material gives the body its **mass** and moments of inertia, and it carries the mechanical and thermal properties that strength and temperature checks read.

## The built-in materials

| Material                    | Kind    | Form    | Typical density | Density source                                       |
| --------------------------- | ------- | ------- | --------------- | ---------------------------------------------------- |
| PLA                         | plastic | printed | 1240 kg/m³      | NatureWorks Ingeo 4043D data sheet                   |
| PETG                        | plastic | printed | 1270 kg/m³      | Eastman Eastar 6763 data sheet                       |
| ABS                         | plastic | printed | 1040 kg/m³      | INEOS Styrolution Terluran GP-22 data sheet          |
| PC (polycarbonate)          | plastic | printed | 1200 kg/m³      | Bambu Lab PC data sheet V2.0                         |
| PA12 (SLS)                  | plastic | printed | 930 kg/m³       | EOS PA 2200 Balance data sheet (laser-sintered part) |
| PA-CF (carbon-filled nylon) | plastic | printed | 1090 kg/m³      | Bambu Lab PA6-CF data sheet V3.0                     |
| POM (acetal)                | plastic | moulded | 1410 kg/m³      | Ensinger TECAFORM AH natural data sheet              |
| Pine (eastern white)        | wood    | wood    | 400 kg/m³       | The Wood Database, at 12% moisture content           |
| Oak (red)                   | wood    | wood    | 700 kg/m³       | The Wood Database, at 12% moisture content           |
| Plywood (birch)             | wood    | panel   | 680 kg/m³       | Birch plywood makers' data                           |
| MDF                         | wood    | panel   | 750 kg/m³       | European Panel Federation (600 to 800 kg/m³)         |
| Aluminium 6061 (T6)         | metal   | wrought | 2700 kg/m³      | ASM data sheet for 6061-T6                           |
| Aluminium 7075 (T6)         | metal   | wrought | 2810 kg/m³      | ASM data sheet for 7075-T6                           |
| Steel (carbon)              | metal   | wrought | 7850 kg/m³      | EN 1993-1-1 (Eurocode 3)                             |
| Steel 1018 (cold drawn)     | metal   | wrought | 7870 kg/m³      | MatWeb, AISI 1018 cold drawn                         |
| Steel 4140 (annealed)       | metal   | wrought | 7850 kg/m³      | AZoM, AISI 4140                                      |
| Stainless steel 304         | metal   | wrought | 8000 kg/m³      | AZoM, grade 304                                      |
| Brass (C36000)              | metal   | wrought | 8500 kg/m³      | Copper Development Association, C36000               |

The materials that were there before the mechanical properties came keep their names and densities, so the mass of a body in an existing document does not change.

## Properties

Each material can have these properties. A property no source gives is left blank rather than guessed; a check that needs a blank one says so and does not produce a number.

- **Elastic modulus** (stiffness) and **Poisson's ratio**.
- **Yield strength** (0.2% offset unless noted) and **ultimate strength**; for printed materials, the **ultimate strength across the layers** (Z) as well.
- **Endurance limit**: the stress a fully reversed load can repeat without fatigue failure, with the number of cycles it holds for.
- **Elongation** at break.
- **Thermal conductivity**, **specific heat** and **thermal expansion**.
- **Maximum service temperature**.

Mechanical properties (strengths in MPa, an asterisk marks a specification minimum rather than a typical value):

| Material                | Elastic modulus | Yield | Ultimate | Ultimate, Z | Endurance limit | Elongation |
| ----------------------- | --------------- | ----- | -------- | ----------- | --------------- | ---------- |
| PLA                     | 2.58 GPa        |       | 35       | 31          |                 | 12.2%      |
| PETG                    | 2.78 GPa        |       | 51       | 35          |                 | 9.5%       |
| ABS                     | 2.20 GPa        |       | 33       | 28          |                 | 10.5%      |
| PC                      | 2.11 GPa        |       | 62       | 56          |                 | 3.8%       |
| PA12 (SLS)              | 1.65 GPa        |       | 48       | 42          |                 | 18%        |
| PA-CF                   | 4.43 GPa        |       | 102      | 48          |                 | 5.8%       |
| POM                     | 3.10 GPa        |       | 64       |             |                 | 30%        |
| Pine (eastern white)    | 8.55 GPa        |       |          |             |                 |            |
| Oak (red)               | 12.14 GPa       |       |          |             |                 |            |
| Aluminium 6061 (T6)     | 68.9 GPa        | 276   | 310      |             | 96.5            | 12%        |
| Aluminium 7075 (T6)     | 71.7 GPa        | 503   | 572      |             | 159             | 11%        |
| Steel (carbon)          | 210 GPa         | 235\* | 360\*    |             |                 | 15%\*      |
| Steel 1018 (cold drawn) | 200 GPa         | 370   | 440      |             | 220             | 15%        |
| Steel 4140 (annealed)   | 200 GPa         | 415   | 655      |             | 327.5           | 25.7%      |
| Stainless steel 304     | 193 GPa         | 190\* | 500\*    |             |                 | 45%\*      |
| Brass (C36000)          | 97 GPa          | 310   | 400      |             |                 | 25%        |

Thermal properties:

| Material                | Conductivity | Specific heat | Expansion     | Maximum service temperature |
| ----------------------- | ------------ | ------------- | ------------- | --------------------------- |
| PLA                     |              |               |               | 54 °C                       |
| PETG                    |              |               |               | 68 °C                       |
| ABS                     |              |               |               | 84 °C                       |
| PC                      |              |               |               | 117 °C                      |
| PA12 (SLS)              |              |               |               | 57 °C                       |
| PA-CF                   |              |               |               | 164 °C                      |
| POM                     | 0.39 W/(m·K) | 1400 J/(kg·K) | 136 µm/(m·K)  | 100 °C                      |
| Aluminium 6061 (T6)     | 167 W/(m·K)  | 896 J/(kg·K)  | 23.6 µm/(m·K) |                             |
| Aluminium 7075 (T6)     | 130 W/(m·K)  | 960 J/(kg·K)  | 23.4 µm/(m·K) |                             |
| Steel (carbon)          | 45 W/(m·K)   | 600 J/(kg·K)  | 12 µm/(m·K)   |                             |
| Steel 1018 (cold drawn) | 51.9 W/(m·K) | 486 J/(kg·K)  |               |                             |
| Steel 4140 (annealed)   | 42.6 W/(m·K) |               | 12.2 µm/(m·K) |                             |
| Stainless steel 304     | 16.2 W/(m·K) |               | 17.2 µm/(m·K) |                             |
| Brass (C36000)          | 115 W/(m·K)  | 380 J/(kg·K)  | 20.5 µm/(m·K) |                             |

Where each value comes from:

- **PLA, PETG, ABS, PC and PA-CF**: the Bambu Lab technical data sheets (PLA Basic V3.0, PETG Basic V3.0, ABS V3.0, PC V2.0, PA6-CF V3.0), tensile values to ISO 527 on specimens printed at 100% infill. The maximum service temperature is the heat deflection temperature at 1.8 MPa (ISO 75): a short-term softening point under load, not a rating for continuous use. The PC sheet gives 112 °C at 0.45 MPa, below its 117 °C at 1.8 MPa, which is unusual (a lighter load normally gives a higher temperature), so treat PC's figure with care.
- **PA12**: the EOS PA 2200 Balance data sheet, laser sintered, with X, Y and Z values. Its maximum service temperature is the heat deflection temperature at 1.80 MPa in Z.
- **POM**: the Ensinger TECAFORM AH natural (POM-C) stock shapes data sheet, for extruded rod and plate; the maximum service temperature is its long-term service temperature.
- **Pine and oak**: The Wood Database, the elastic modulus along the grain from bending tests at 12% moisture content. Wood is far weaker across the grain, and the strengths it publishes (modulus of rupture, crushing strength) are not the tensile strengths this list holds, so they are left out.
- **Aluminium 6061 and 7075**: the ASM Aerospace Specification Metals data sheets for the T6 temper. Their endurance limit is the fatigue strength at 500 million fully reversed cycles: aluminium has no true endurance limit, so a part loaded for longer can still fail.
- **Steel (carbon)**: EN 1993-1-1 (Eurocode 3) for the elastic modulus, Poisson's ratio, expansion and the nominal strengths of grade S235; EN 1993-1-2 for the simplified conductivity and specific heat. These strengths are specification minimums; a stronger grade is another material.
- **Steel 1018**: the MatWeb data sheet for cold drawn 1018. **Steel 4140**: the AZoM article on AISI 4140, annealed; quenched and tempered 4140 is much stronger. Their endurance limits are estimates, half the ultimate strength (Shigley's Mechanical Engineering Design, eq. 6-8), for a polished test specimen: a real shaft's limit is lower once its size, surface and loading are allowed for.
- **Stainless steel 304**: the AZoM article on grade 304, minimums for bar and section.
- **Brass**: the Copper Development Association data sheet for C36000 free-cutting brass, half-hard (H02) rod up to 25 mm; its yield strength is at 0.5% extension under load.

## Typical values

Every value is **typical** unless it is marked as a specification minimum (the asterisks above): what a data sheet reports for the material, not a guarantee for the stock you buy. Real stock varies: wood with species, growth and moisture; panels by maker and thickness; filament by brand, colour, additives and how dry it is; metal with temper, size and supplier. Where a part matters, use the figures from your supplier's certificate or data sheet, and keep a margin. Masses and moments of inertia are estimates for the same reason.

## Printed parts

A printed part is not the same in every direction. It is strongest along its lines in the build plane (**XY**) and weakest **across the layers (Z)**, where only the bond between one layer and the next holds it together. The printed materials here give both where their maker publishes both: PLA keeps about 90% of its XY strength across the layers, PETG about 70%, and carbon-filled nylon under half, because its fibres lie in the plane. Their stiffness and elongation drop across the layers too: PLA's elastic modulus is 2.58 GPa in XY and 2.06 GPa in Z, carbon-filled nylon's 4.43 and 2.17 GPa. Laser-sintered PA12 is the exception for stiffness, the same in every direction, but it stretches far less across its layers (4% against 18%).

So how a part is turned on the bed changes how strong it is: lay it so that the main load runs along the layers, not across them. The figures come from solid test bars at 100% infill; a part with less infill, fewer walls, a different nozzle temperature or a wet filament is weaker again.

When a printed material gives no Z strength, a strength check multiplies the XY strength by a **printed-part knockdown**. The starting value is **0.5**: about the lowest Z/XY ratio in the data sheets above (0.47, for carbon-filled nylon), and inside the range Ahn and others measured for printed ABS (10% to 73% of moulded strength, depending on how the lines run; "Anisotropic material properties of fused deposition modeling ABS", Rapid Prototyping Journal 8(4), 2002). It is a stand-in, not a measurement: a straight-line, same-in-every-direction strength model does not capture layer bonding, infill or orientation. For a part that matters, print test pieces the way the part is printed and break them.

The mass of a printed part is its solid volume times the density, so it is too high by the share of infill the slicer leaves out.
