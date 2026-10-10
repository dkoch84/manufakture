# Reference machines, catalog data and standards: research for M9

- Status: research, input to the [M9 plan](../plans/m9.md) (task T9.0c)
- Date: 2026-10-10
- Question: what do published specifications say a portable cable trainer must do, what do the datasheets of the parts that could build one actually state (and in which conventions), and which standards should a builder know about? The answers feed the scenario's requirement list (T9.11a) and the field lists of the catalogs (T9.2b to T9.2e).

## Method and conventions

Everything here was read from manufacturer pages, manufacturer datasheets, help-centre articles or, where no manufacturer page could be read, distributors and reviews. Each row names its source; the [Sources](#sources) section lists them all.

- **Published** means the number appears in the cited source as written. Units were converted where noted (1 lbf = 4.448 N; 1 in = 25.4 mm).
- **Estimated** means it was derived here from published numbers with stated assumptions. Estimates are illustrative inputs for the plan and the scenario; T9.0b and T9.4b replace them with modelled values.
- **Unverified** means it came from a secondary source (a review, a distributor, a search summary) or from general knowledge and was not confirmed in a manufacturer document. Catalog entries built from these stay `verified: false` (plan decision 7).
- Standards are named with their scope only. No text from any standard was read or copied; scopes come from the publishers' catalogue pages and test-house summaries.
- Values may have changed since the date above. Nothing here claims a listed part is current or that a design using it is safe.

## Summary

- The class is real and tight: the two battery machines found (Beyond Power Voltra I and Speediance Gym Nano) both carry a pack just under 100 Wh (97.9 Wh and 95.68 Wh), weigh 5.8 kg and 8.2 kg, and reach 200 to 220 lbf with 1 lb steps. The mains machines (Tonal 2, Vitruvian Trainer+, Speediance Gym Monster 2, AEKE K1) are 38 to 78 kg and go to 220 to 440 lbf over two cables.
- The Voltra's own help centre gives a usable energy figure: about 6 sessions at 100 lb or 14 at 60 lb per charge. Worked backwards (estimated), that is about 500 J per rep at 100 lb, and the energy per session grows faster than force, which points at copper losses and little recovered regeneration.
- Its pack is 57.6 V nominal, which reads as 16 cells in series (67.2 V full). That rules out several popular open FOC controllers on voltage alone (ODrive S1 50.5 V, ODrive Pro 58 V, moteus-n1 54 V) and requires fuses rated above the common 58 V automotive class. Requirements about parts, not only performance, as the plan says.
- Under 100 Wh, high voltage forces small cells: sixteen cells must each hold at most 6.1 Wh, while a high-power 21700 holds about 15 to 16 Wh. Fewer, bigger cells mean a low bus voltage and high current. This trade is the heart of the electrical sizing.
- Datasheets disagree on conventions. Resistance is "phase-neutral" (ODrive), "phase to phase" (CubeMars) or "line to center" (mjbots); torque constants may be motor side or output side for geared actuators; connector names (XT60, XT90) are not their continuous ratings. The catalogs must store the convention with the number.
- A 7/64 in (2.8 mm) HMPE rope at the usual 7:1 synthetic-rope factor gives a working load of about 890 N, which is exactly 200 lbf. Steel 7x19 cable wants a drum 34 to 51 times its diameter, which a portable box cannot hold; that is why these machines use fibre.

## 1. Reference machines

### Published specifications

| Machine (source)                                                                                                                                                                | Force range and step                                                                                                                                                                           | Cable                                                                                                                             | Speed                                                                                                                                                                           | Mass                                                                                                                                                  | Size (L × W × H)                                        | Power                                                                                                                                                                                           | Modes                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Beyond Power Voltra I ([product page](https://www.beyond-power.com/products/voltra); [cable article](https://help.beyond-power.com/en/articles/10124119-how-long-is-the-cable)) | 5 to 200 lb (2 to 90 kg); 1 lb steps (step unverified: from [a guide](https://hypertrophyprotocol.com/lifting-protocols/beyond-power-voltra-guide/) and reviews, not seen on the product page) | 2.6 m (8.5 ft) on the product page; 2.85 m (9.4 ft) in the help centre; 3 mm (0.11 in) synthetic fibre; connector titanium and PE | not published; Beginner, Normal and Sport settings change the speed and force limits ([review](https://graymatterlifting.com/beyond-power-voltra-i-review/), numbers not given) | 5.8 kg (12.78 lb)                                                                                                                                     | 323 × 139 × 100 mm                                      | Li-ion 97.9 Wh, 57.6 V, 1.7 Ah; USB-C charging up to 140 W; 2 h at 65 W, 1 h 20 min at 100 W (search summary of the help centre, unverified); 0 to 40 °C operating                              | Weight training with eccentric overload, resistance band, damper, isokinetic, isometric testing, custom curves, rowing, skiing |
| Speediance Gym Nano ([business page](https://business.speediance.com/gym-nano/))                                                                                                | 3.5 to 100 kg (8 to 220 lb); 1 lb steps                                                                                                                                                        | 5.1 m; composite steel-core cable, designed for at least 50,000 cycles                                                            | 6.4 m/s maximum cable speed                                                                                                                                                     | 8.2 kg net ([search summary](https://androidguys.com/news/speediance-gym-nano-packs-220-pounds-of-resistance-into-a-carry-on-sized-gym/), unverified) | not found                                               | Li-ion 2000 mAh, 95.68 Wh; up to 8 h of use per charge "under specified conditions"; charges while in use                                                                                       | Standard, eccentric, chain, fixed speed, sled, isometric                                                                       |
| Tonal 2 ([Tonal blog](https://tonal.com/blogs/all/experience-the-future-of-fitness-with-tonal-2) and [review](https://www.garagegymreviews.com/tonal-review))                   | 5 to 250 lb total, 125 lb per arm; 1 lb steps                                                                                                                                                  | two arms; length not found                                                                                                        | not found                                                                                                                                                                       | about 68 kg (150 lb) (unverified, search summary)                                                                                                     | 21.5 in W × 5.25 in D × 50.9 in H (546 × 133 × 1293 mm) | mains, 3-prong outlet within 6 ft                                                                                                                                                               | Eccentric, chains, burnout, spotter, and others                                                                                |
| Vitruvian Trainer+ / V-Form ([hardware and electrical specifications](https://knowledge.vitruvianform.com/support/hardware-and-electrical-specifications))                      | 0 to 100 kg per rope, active range 4 to 100 kg per rope (200 kg total)                                                                                                                         | 3 m per rope, Dyneema core                                                                                                        | not found                                                                                                                                                                       | 38 kg                                                                                                                                                 | 1170 × 520 × 115 mm                                     | mains, 110 to 240 V, dedicated 20 A circuit, earthed, RCD or GFCI; 1000 W maximum ([review](https://www.gadgetguy.com.au/vitruvian-trainer-the-ultimate-home-gym-solution-review/), unverified) | not listed on that page                                                                                                        |
| Speediance Gym Monster 2 ([fitshop](https://www.fitshop.co.uk/speediance-gym-monster-2-sp-gm2), unverified)                                                                     | up to 100 kg total, 50 kg (110 lb) per side; 1 lb or 0.5 kg steps                                                                                                                              | high-strength PE fibre                                                                                                            | not found                                                                                                                                                                       | 78 kg                                                                                                                                                 | 1220 × 690 × 1850 mm unfolded                           | mains                                                                                                                                                                                           | not checked                                                                                                                    |
| AEKE K1 ([manual summary](https://manuals.plus/asin/B0FR4WF6Q6) and [FAQ](https://aeke.com/pages/faq), unverified)                                                              | 2 to 50 kg per side, 220 lb total                                                                                                                                                              | not found                                                                                                                         | not found                                                                                                                                                                       | about 77 kg                                                                                                                                           | 455 × 693 × 1740 mm folded                              | mains                                                                                                                                                                                           | Concentric, eccentric, constant, elastic, rowing                                                                               |

Also seen, outside the class: the GoTone Pro, a 0.7 kg handheld at 3 to 30 kg ([comparison](https://rayofi.com/blogs/news/gotone-pro-vs-voltra-vs-speediance-gym-nano), unverified).

Notes on the published numbers:

- **The Voltra's cable length has two published values.** The product page says 2.6 m; the help-centre article says 2.85 m. The plan uses 2.85 m. Plausibly one is the usable travel and the other the total length on the spool, but no source says so. The scenario should state which it means (travel out of the fairlead), and T9.3b should model both (total length sets the spool's wound diameter; travel sets the requirement).
- **Cable material.** The Voltra product page says "synthetic fibre"; a search summary of the help centre says Kevlar (unverified). Vitruvian says Dyneema core. Speediance's Gym Nano uses a steel-core composite; its Gym Monster 2 uses PE fibre.
- **Sessions per charge (Voltra help centre, via search summary, unverified wording):** using 100 lb throughout a session of 12 to 14 sets of 8 to 10 reps with about 1 minute rest gives about 6 sessions; at 60 lb, up to 14.
- **The airline line.** Both battery machines sit just under 100 Wh, the threshold below which passengers carry lithium-ion batteries without airline approval ([IATA](https://www.iata.org/en/youandiata/travelers/batteries/)). That is a design target, not a coincidence.

### What the published numbers imply (estimated)

- **Pack layout.** 57.6 V / 3.6 V = 16, so the Voltra pack is most likely 16 cells in series: 67.2 V at full charge (4.2 V per cell) and about 48 V at a 3.0 V cutoff. 1.7 Ah per string suggests 16S1P of roughly 1.7 Ah, 6.1 Wh cells (small 18650s or pouch cells). The Gym Nano's 95.68 Wh at 2.0 Ah is 47.84 V, which reads as 13 cells in series at 3.68 V. Neither maker publishes the layout.
- **Energy per rep at 100 lb.** Assume 13 sets of 9 reps (117 reps) and a 0.6 m stroke. 97.9 Wh = 352 kJ; over 6 sessions that is 58.7 kJ per session, about 500 J per rep. One phase of one rep at 100 lbf (445 N) over 0.6 m is 267 J. So each rep costs about twice the work of one phase, consistent with the motor supplying the return stroke (267 J plus losses) and recovering little of the pull stroke.
- **Scaling with force.** 60 lb gives 14 sessions, 25.2 kJ per session. The energy ratio between 100 lb and 60 lb is 2.33, between the force ratio (1.67) and its square (2.78). Copper losses scale with the square of current, hence of force; this is the signature of losses that matter. The simulation in T9.4b should reproduce both published points, which makes them a good validation target.
- **Charging.** 97.9 Wh at 65 W is 1.5 h before charger and cell taper losses; the published 2 h at 65 W fits.
- **Regenerative current.** The plan's 1.1 kW into a 57.6 V bus is 19 A; on 1.7 Ah cells that is about 11 C. High-power 21700 cells accept 1 to 3 C (section 2.3), so the energy has to go somewhere else (a braking resistor), as the plan says.

## 2. Representative parts

### 2.1 Motors

| Part (source)                                                                                                                                  | Kind                                | Kv (rpm/V)                        | Kt (N·m/A)                                | Resistance (convention)                                                                   | Inductance            | Pole pairs | Current: continuous / peak                    | Torque: continuous / peak               | Mass                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------- | ---------- | --------------------------------------------- | --------------------------------------- | ------------------------------- |
| ODrive D6374 150KV ([ODrive docs](https://docs.odriverobotics.com/v/latest/hardware/odrive-motors.html))                                       | outrunner                           | 150                               | 0.055                                     | 39 mΩ phase-neutral                                                                       | 24 µH                 | 7          | 50 A free air, 70 A forced air / 90 A for 3 s | 2.75 / 4.95 (estimated as Kt × current) | not read                        |
| ODrive D5065 270KV (same)                                                                                                                      | outrunner                           | 270                               | 0.031                                     | 39 mΩ phase-neutral                                                                       | 16 µH                 | 7          | 45 A / 65 A forced / 85 A for 3 s             | 1.4 / 2.6 (estimated)                   | not read                        |
| ODrive M8325s 100KV (same)                                                                                                                     | outrunner, wide                     | 100                               | 0.083                                     | 24 mΩ phase-neutral                                                                       | 9.9 µH                | 20         | 40 A / 60 A forced / 80 A for 3 s             | 3.3 / 6.6 (estimated)                   | not read                        |
| ODrive Botwheel (same)                                                                                                                         | hub motor                           | 8.7                               | 0.951                                     | 0.8 Ω phase-neutral                                                                       | 1.7 mH                | 15         | 5 A / 15 A for 3 s                            | 4.8 / 14 (estimated)                    | not read                        |
| mjbots mj5208 ([product page](https://mjbots.com/products/mj5208))                                                                             | gimbal-style outrunner              | 330                               | not stated (0.025 estimated as 8.27 / Kv) | 0.047 Ω line to center ([search summary](https://mjbots.com/products/mj5208), unverified) | not stated            | not stated | not stated                                    | peak 1.7 N·m                            | 193 g with wires                |
| iFlight GM5208-24 ([search summary](https://shop.iflight.com/ipower-motor-gm5208-24-brushless-gimbal-motor-pro1347), unverified)               | gimbal (24N22P)                     | no-load 396 to 436 rpm on 3 to 5S | not stated                                | 25.6 Ω (convention not stated)                                                            | not stated            | 11         | power at most 40 W                            | "4 kg·cm" (0.39 N·m)                    | 204 g                           |
| CubeMars RO100 KV55 ([search summary](https://www.cubemars.com/product/ro100-kv55-standard-with-hall-frameless-torque-motor.html), unverified) | frameless torque outrunner          | 55                                | not found                                 | not found                                                                                 | not found             | not found  | 20 A rated                                    | 4 / 12                                  | 710 g                           |
| CubeMars AK80-9 V3.0 ([product page](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html))                                      | geared actuator, 9:1, delta winding | 100 (motor side, estimated)       | 0.095 (motor side, estimated)             | 160 mΩ phase to phase                                                                     | 116 µH phase to phase | 21         | 12 A rated / 28 A peak                        | 9 / 22 at the output                    | 490 g; rotor inertia 1118 g·cm² |

Conventions, which the catalog must carry rather than assume:

- **Kt from Kv.** ODrive's numbers all satisfy Kt = 8.27 / Kv (150 gives 0.0551, 270 gives 0.0306, 100 gives 0.0827, 8.7 gives 0.951). ODrive states that its voltages are line-to-line amplitude and its currents phase amplitude. 8.27 is (60 / 2π) × (√3 / 2), the factor that relates rpm per line-to-line volt to newton-metres per phase-amplitude amp for a sinusoidal three-phase machine (derivation estimated; the relation is checked against ODrive's table). mjbots now defines Kv by the peak-to-peak voltage between two phases on an oscilloscope ([mjbots blog](https://blog.mjbots.com/2025/04/17/representing-torque-constant-as-kv-in-moteus/)). A catalog must record which Kv definition and which current measure (amplitude or RMS) the entry uses; RMS current instead of amplitude changes Kt by √2.
- **Resistance.** "Phase-neutral" (ODrive), "phase to phase" (CubeMars) and "line to center" (mjbots) are different measurements. For a wye winding, line-to-line resistance is twice the phase value. For a delta winding (the AK80-9), the measured line-to-line value is two thirds of one winding's resistance, and the equivalent wye phase resistance is half the line-to-line value. Copper loss uses the equivalent phase resistance: P = 3/2 × R_phase × I_amplitude². Store the measured value, its convention and the winding, and derive the equivalent phase value.
- **Geared actuators.** The AK80-9's Kt (0.095) and Kv (100) are consistent with the motor side: 48 V × 100 rpm/V / 9 = 533 rpm, against a published 570 rpm no-load at the output. Its rated output torque per amp (9 N·m / 12 A = 0.75) is 88% of 0.095 × 9 = 0.855, which would be the gear efficiency (estimated). The catalog needs `ratio` and a flag saying whether each constant is motor side or output side.
- **Torque at the spool (estimated).** 200 lbf on a 25 mm radius is 22 N·m. No direct-drive motor above makes that continuously: the AK80-9's 22 N·m is its peak; a D6374 through 5:1 gives 13.8 N·m continuous and 24.8 N·m peak, before belt losses. A 30 s isometric hold at 200 lbf therefore sits on the peak rating of most candidates, which is exactly what the thermal model (T9.4b) must judge, and why thermal fields are required.
- **Missing everywhere.** None of the motor pages read gives thermal resistance, thermal time constant, maximum winding temperature or an iron-loss model. The catalogs need those fields, but entries will mostly carry them as `unknown` or as estimates, and the calc records must say so (plan decision 4).

### 2.2 Controllers (open-hardware FOC)

| Part (source)                                                                                                                                                                                                                 | Bus voltage              | Phase current                                                                        | Power                                                                             | Regeneration and braking                             | Loop and PWM                           | Feedback                                                                   | Bus                                             | Size, mass                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| ODrive S1 ([datasheet](https://docs.odriverobotics.com/v/latest/hardware/s1-datasheet.html))                                                                                                                                  | 12 to 50.5 V absolute    | 20 to 40 A continuous free air; 40 to 80 A with heat spreader; peak by voltage curve | 2 kW continuous                                                                   | dedicated brake resistor output; one resistor per S1 | not stated                             | onboard encoder, RS-485, incremental, Hall, SPI (RS-485 and SPI exclusive) | USB, CAN, UART                                  | not read                                  |
| ODrive Pro ([datasheet](https://docs.odriverobotics.com/v/latest/hardware/pro-datasheet.html))                                                                                                                                | 15 to 58 V               | 20 to 80 A continuous free air, 80 to 100 A cooled, 100 A peak for 3 s               | 5 kW peak                                                                         | no integrated brake resistor (external)              | configurable                           | incremental, RS-485, Hall, SPI                                             | USB, CAN to 12 Mbit/s, UART, step and direction | 51 × 64 × 17.5 mm; 32 g bare, 140 g cased |
| mjbots moteus-n1 ([product page](https://mjbots.com/products/moteus-n1))                                                                                                                                                      | 10 to 54 V (12S at most) | 9 A continuous without, 26 A with thermal management; 100 A peak                     | 2 kW peak at 36 V                                                                 | not stated                                           | control 15 to 30 kHz; PWM 15 to 60 kHz | integrated absolute magnetic encoder                                       | CAN-FD 5 Mbit/s                                 | 46 × 46 × 8 mm; 14.6 g                    |
| Flipsky 75100 (VESC-based) ([search summary](https://theflipsky.com/product/flipsky-75100-v2-0-with-aluminum-pcb-with-power-switch-button-based-on-vesc-for-electric-skateboard-scooter-ebike-speed-controller/), unverified) | 14 to 84 V (4 to 20S)    | 100 A continuous, 120 A burst (seller figures)                                       | not stated                                                                        | regenerative braking into the battery                | not stated                             | ABI, Hall, AS5047, AS5048A                                                 | USB, CAN, UART                                  | 103 × 58 × 27.7 mm                        |
| ODrive 2 Ω 50 W brake resistor ([shop](https://shop.odriverobotics.com/products/set-of-8-brake-resistors))                                                                                                                    | for use with the above   |                                                                                      | 50 W continuous (rating assumes some moving air, per community notes, unverified) |                                                      |                                        |                                                                            |                                                 |                                           |

Implications (estimated):

- **Voltage rules out most of them for a 16S pack.** A Voltra-like 16S pack reaches 67.2 V full. The S1 (50.5 V), Pro (58 V) and moteus-n1 (54 V) are all below it; only the VESC-class 75 V or 84 V parts fit. A design on those three needs 12S or fewer (50.4 V full), which at the same energy means more current. The sizing study must check the controller's absolute maximum against the pack's maximum voltage plus the regenerative rise, not against the nominal.
- **Where the regenerated energy goes is a controller property.** ODrive dumps it into a brake resistor; VESC firmware returns it to the battery. With 1.7 Ah cells the battery cannot take 11 C, so a VESC-style controller would need an external chopper and resistor or a current limit on regeneration. The catalog needs "regeneration: to bus, chopper output yes or no, chopper current".
- **Resistor sizing.** At 58 V, 2 Ω absorbs 58² / 2 = 1.7 kW at full duty, enough for the plan's 1.1 kW peak, but 50 W continuous. One 200 lbf pull returns about 530 J (plan); at one rep every 4 s that is 130 W average, over twice the continuous rating. Pulse energy and thermal time constant are therefore needed fields, not only watts.

### 2.3 Cells

| Cell (source)                                                                                                                                                             | Format | Capacity                                     | Nominal / charge / cutoff V | Charge current: standard / max | Continuous discharge          | Impedance                               | Mass       | Charge temperature                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- | --------------------------- | ------------------------------ | ----------------------------- | --------------------------------------- | ---------- | ----------------------------------- |
| Molicel INR-21700-P45B ([datasheet v1.2](https://www.molicel.com/wp-content/uploads/INR21700P45B_1.2_Product-Data-Sheet-of-INR-21700-P45B-80109.pdf))                     | 21700  | 4.5 Ah typical, 4.3 Ah min (16.2 Wh typical) | 3.6 / 4.2 / 2.5 V           | 4.5 A / 13.5 A (70 °C cutoff)  | 45 A (80 °C cutoff)           | AC 7 mΩ at 30% SOC; DC 15 mΩ at 50% SOC | 70 g max   | 0 to 60 °C (discharge −40 to 60 °C) |
| Molicel INR-21700-P42A ([product page](https://www.molicel.com/product/inr-21700-p42a/))                                                                                  | 21700  | 4.2 Ah typical                               | 3.6 V nominal               | 4.2 A                          | 45 A                          | not on page                             | 70 g max   | not on page                         |
| Samsung INR21700-40T ([search summary of the datasheet](https://www.nkon.nl/en/samsung-inr21700-40t5-4000mah-35a.html), unverified)                                       | 21700  | 4.0 Ah nominal, 3.9 Ah rated                 | 3.6 / 4.2 / 2.5 V           | 2 A / 6 A                      | 35 A (45 A with 80 °C cutoff) | not confirmed                           | 67 g       | not confirmed                       |
| Molicel INR-18650-P28A ([distributor](https://www.nkon.nl/en/molicel-inr18650-p28a-2800mah-35a.html), unverified)                                                         | 18650  | 2.8 Ah                                       | 3.6 / 4.2 V                 | not confirmed                  | 35 A                          | 20 mΩ max AC at 1 kHz (unverified)      | about 46 g | not confirmed                       |
| Samsung INR18650-30Q ([datasheet copy](https://files.batteryjunction.com/frontend/files/samsung/datasheet/SAMSUNG-30Q-18650-3000-FLAT-Datasheet.pdf), via search summary) | 18650  | 3.0 Ah nominal, 2.95 Ah min                  | 3.6 / 4.2 / 2.5 V           | 1.5 A / 4 A                    | 15 A                          | 26 mΩ max initial                       | 48 g max   | not confirmed                       |

The 100 Wh trade (estimated):

- **Sixteen in series under 100 Wh means at most 6.1 Wh per cell.** None of the cells above is that small: a P45B holds 16.2 Wh, so six P45Bs (97.2 Wh, 6S, 25.2 V full) are the most a sub-100 Wh pack of them can hold; P28As (10.1 Wh) allow nine. The Voltra's 1.7 Ah strings point at a smaller cell than any listed here; the catalog should include at least one small high-rate cell or pouch cell so the sizing study can reach a 16S pack.
- **Low voltage costs speed.** With a direct drive at Kt about 0.5 N·m/A (the plan's figure), 1.5 m/s on a 25 mm spool is 60 rad/s and about 30 V of back-EMF plus IR drop. A 6S pack (18 to 25 V) cannot reach it at full force; a 16S pack can. So bus voltage, cell count and the speed requirement constrain each other, and the requirement list must contain all three.
- **Charge acceptance.** The P45B's maximum charge is 13.5 A (3 C) with a 70 °C cutoff; the 40T's 6 A (1.5 C). That bounds what regeneration the pack can absorb and what charger power is useful: a 140 W USB-C charger into a 57.6 V pack is 2.4 A, which a 1.7 Ah string sees as 1.4 C.
- **Mass.** Sixteen 46 g cells weigh 0.74 kg; six 70 g cells 0.42 kg, before interconnects, BMS and enclosure. Both fit a 6 kg machine.

### 2.4 Bearings (deep groove, 60 series)

| Bearing (source)                                                                                                                                           | d × D × B (mm) | C dynamic | C0 static | Fatigue limit Pu | Limiting speed                                           | Mass      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | --------- | ---------------- | -------------------------------------------------------- | --------- |
| SKF 6001-2RSH ([search summary](https://www.mrosupply.com/bearings/319810_6001-2rsh_skf-bearing/), unverified)                                             | 12 × 28 × 8    | 5.4 kN    | 2.36 kN   | 0.1 kN           | 17,000 r/min (unverified; seems high for a contact seal) | not found |
| SKF 6004-2RSH ([search summary](https://www.skf.com/au/products/rolling-bearings/ball-bearings/deep-groove-ball-bearings/productid-6004-2RSH), unverified) | 20 × 42 × 12   | 9.95 kN   | 5 kN      | not found        | 11,000 r/min                                             | not found |
| SKF 6005-2RSH ([bearingsize.info catalogue](https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-6005-2rsh-skf-obj32488.html))      | 25 × 47 × 12   | 11.9 kN   | 6.6 kN    | 0.275 kN         | 9,500 r/min                                              | 0.0806 kg |

SKF's own product pages render their tables with script and could not be read; T9.2d should check each entry against SKF's catalogue before marking it verified. The spool runs at most a few hundred rpm (573 rpm at 1.5 m/s on 25 mm, from the plan), far below any limiting speed, so life (ISO 281, C against the radial load from 890 N of cable pull) and static capacity (C0 against shock) govern. Seal type matters for friction at low speed (contact seals such as 2RSH add drag; shields such as 2Z less), so the catalog should record the closure.

### 2.5 Timing belts

From Gates' Light Power and Precision design manual, table 6 (long-length belting; rated working tension depends on the number of grooves on the smaller pulley), converted from pounds:

| Belt                 | Width | Rated working tension, by pulley grooves | Fewest grooves in the table | Minimum breaking strength |
| -------------------- | ----- | ---------------------------------------- | --------------------------- | ------------------------- |
| 2MGT (GT2/GT3, 2 mm) | 6 mm  | 169 N (12 grooves) to 173 N (45)         | 12                          | 556 N                     |
| 3MGT (3 mm)          | 15 mm | 627 N (16) to 734 N (45)                 | 16                          | 2.85 kN                   |
| 5MGT (5 mm)          | 15 mm | 614 N (18) to 934 N (45)                 | 18                          | 5.85 kN                   |
| HTD 5M (5 mm)        | 15 mm | 365 N (14) to 516 N (45)                 | 14                          | 5.85 kN                   |
| HTD 5M               | 25 mm | 649 N (14) to 921 N (45)                 | 14                          | 9.74 kN                   |

Also from the same manual: rate drives with at least 6 teeth in mesh and subtract 20% of the rating for each tooth fewer (to a minimum of 2); give each loaded pulley at least 60° of wrap; drives are tensioned for an 8:1 tight-to-slack ratio, with tight side tension TT = 2.286 Q / Pd and slack side TS = 0.285 Q / Pd (Q torque, Pd pitch diameter, any consistent units), whose vector sum is the shaft load the bearings carry.

Worked example (estimated): a 5:1 reduction carrying 4.5 N·m on a 20-groove 5MGT pulley (pitch diameter 20 × 5 / π = 31.8 mm) gives TT = 2.286 × 4.5 / 0.0318 = 323 N, about half the 15 mm belt's rated tension at that groove count. The large pulley would have 100 grooves (159 mm pitch diameter), wider than the Voltra's 139 mm box; a two-stage reduction or a smaller ratio is the likely answer, which is the kind of finding the sizing study should surface.

### 2.6 Synthetic rope and steel cable

| Line (source)                                                                                                                                                                       | Diameter         | Strength                                                                                                                          | Bend guidance                                                                                                                                                                                                          | Notes                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Samson AmSteel-Blue (HMPE, 12-strand) ([distributor](https://www.riggingwarehouse.com/502-872007532830-samson-amsteel-blue-rigging-rope-7-64-x-280-green.html), via search summary) | 7/64 in (2.8 mm) | 1,600 lb (7.1 kN) average, 1,400 lb (6.2 kN) minimum                                                                              | braided HMPE: sheave D:d at least 8:1, 10:1 preferred ([Marlow](https://www.marlowropes.com/news/hmpe-tech-talk-5-working-loads-dd-rations-inspection-shelf-life/); same figure for Samson braids in a search summary) | elastic elongation "similar to wire rope" (seller wording); 0.3 lb per 100 ft |
| HMPE working load ([Marlow](https://www.marlowropes.com/news/hmpe-tech-talk-5-working-loads-dd-rations-inspection-shelf-life/))                                                     |                  | working load limit = spliced minimum breaking load / 7 (the coefficient Marlow attributes to EN and ISO synthetic rope standards) | loops and grommets at least 3:1                                                                                                                                                                                        | creep under sustained load is a known HMPE property; not quantified here      |
| Galvanised aircraft cable 7x19 ([US Cargo Control](https://www.uscargocontrol.com/products/3-32-7x19-galvanized-wire-by-linear-foot))                                               | 3/32 in (2.4 mm) | 1,050 lb (4.7 kN) breaking                                                                                                        | 7x19: suggested D/d 51, minimum 34 ([Industrial Wire Rope Supply](https://industrialrope.com/wire-rope/sheave-and-drum-ratios/))                                                                                       | 1/8 in (3.2 mm) is about 2,000 lb (unverified)                                |

Implications (estimated):

- 6.2 kN minimum / 7 = 886 N, which is 199 lbf: a 2.8 mm HMPE rope carries the full 200 lbf at the conventional factor with nothing to spare, before strength lost at the spool, splices, knots or the handle connector. The Voltra's 3 mm line is consistent with that. The rope check (T9.5) should use the spliced or terminated strength, not the rope's catalogue value.
- At 8:1 a 2.8 mm rope needs a 22 mm spool or fairlead roller, 28 mm at 10:1; the plan's 50 mm spool is about 18:1. A 2.4 mm 7x19 steel cable needs at least 82 mm (34:1) and suggests 122 mm, which does not fit a 100 mm tall box. Speediance's steel-core composite (rated for at least 50,000 cycles) is a third option whose bend data was not found.
- Wound diameter: 2.85 m of 3 mm line on a 50 mm core takes about 15 to 18 turns. Over a 20 mm wide spool (6 to 7 wraps per layer) that is 3 layers, and the effective radius grows by up to 9 mm (estimated). That changes torque per newton by over 30% between full and empty, which is why T9.3b models the spool, and why the force requirement must hold at every payout.

### 2.7 Wire, connectors, fuses

**Wire, copper at 20 °C ([Wikipedia AWG table](https://en.wikipedia.org/wiki/American_wire_gauge)).** Resistance per metre: 10 AWG 3.277 mΩ, 12 AWG 5.211 mΩ, 14 AWG 8.286 mΩ, 16 AWG 13.17 mΩ, 18 AWG 20.95 mΩ. The same table lists ampacities for enclosed wire at 30 °C ambient (12 AWG 25 A at 75 °C insulation, 10 AWG 35 A). Ampacity is not a property of the gauge alone: it depends on the insulation's temperature rating, ambient temperature, bundling and the standard used (building wiring, chassis wiring, automotive). The catalog must store ampacity with its basis, or compute it. Note also that one search result labelled per-foot values as per-metre; tables must be checked for their unit.

**Connectors.** Amass ratings as reproduced by Holybro ([Holybro](https://docs.holybro.com/power-module-and-pdb/power-module/connector-and-wire-rating)), measured as 4 h with less than 60 °C rise (continuous) and 1 min with the same rise (burst):

| Connector | Wire   | Continuous | Burst (1 min) |
| --------- | ------ | ---------- | ------------- |
| XT60      | 12 AWG | 30 A       | 60 A          |
| XT90      | 10 AWG | 45 A       | 90 A          |
| XT120     | 8 AWG  | 60 A       | 120 A         |
| AS150     | 8 AWG  | 75 A       | 150 A         |

A distributor's sheet for the XT60 male ([berrybase](https://www.berrybase.de/en/product-datasheet/0192afa30c5f70b7a5796f0d1be4af74/create)) adds 500 V rated voltage, 1000 mating cycles, −20 to 120 °C and a UL94 V-0 polyamide housing (unverified against an Amass document). The number in the name is roughly the burst rating, not the continuous one, and sellers often quote the name. The plan's 45 A holding current is exactly an XT90's continuous rating.

**Fuses.** Littelfuse makes ATO-style blade fuses rated 58 V DC for 48 V systems, 1 A to 40 A, with a 1000 A interrupting rating at 58 V DC ([Littelfuse TAC ATO 58V datasheet](https://www.mouser.com/datasheet/2/240/Littelfuse-Automotive-Blade-Fuse-TAC-ATO-58V-23798.pdf), via search summary; MINI and MAXI 58 V versions also exist). A 16S pack at 67.2 V exceeds 58 V, so it needs a fuse family rated higher; ordinary automotive blade fuses are 32 V parts (general knowledge, unverified). Interrupting capacity must exceed the pack's short-circuit current (open-circuit voltage over total internal resistance; 16 P45B-class cells at 15 mΩ DC each would be about 67.2 / 0.24 = 280 A, estimated, plus interconnects).

**Braking resistors.** See section 2.2: the one representative found is ODrive's 2 Ω, 50 W part.

## 3. Field lists for the catalogs

Every entry, in every family, carries the fields T9.2a defines: id, family, maker, part number, description, dimensions, mass, source (URL, document title and revision, date read), `verified` (false until checked against the maker's datasheet), notes, optional STEP file. The lists below are the family-specific rating fields. A field marked **(convention)** must store the convention with the value, and the app normalises to one internal convention for calculation. A field marked **(basis)** must store the test conditions. Any field may be `unknown`, and a calc record that needs it reports status `unknown` naming it.

### T9.2b: Motors and controllers

**Motors**

| Field                           | Unit         | Notes                                                                                                                                 |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| kind                            | enum         | outrunner, inrunner, gimbal, frameless, hub, geared actuator                                                                          |
| winding                         | enum         | wye, delta, unknown                                                                                                                   |
| Kv                              | rpm/V        | **(convention)**: line-to-line peak, line-to-line RMS, or peak-to-peak; motor side or output                                          |
| Kt                              | N·m/A        | **(convention)**: per amp of phase amplitude or RMS; motor side or output; if absent, derived from Kv and marked derived              |
| resistance                      | Ω            | **(convention)**: phase-neutral, line-to-line; at what temperature (default 25 °C); copper temperature coefficient assumed 0.00393 /K |
| inductance                      | H            | **(convention)** as resistance; optional Ld and Lq                                                                                    |
| polePairs                       | count        |                                                                                                                                       |
| ratedCurrent, peakCurrent       | A            | **(basis)**: free air, forced air, heat sink; peak duration in s                                                                      |
| ratedTorque, peakTorque         | N·m          | **(basis)** as current; at the output for actuators                                                                                   |
| noLoadSpeed                     | rpm          | at a stated voltage                                                                                                                   |
| ratedSpeed                      | rpm          |                                                                                                                                       |
| maxVoltage                      | V            |                                                                                                                                       |
| ratio, gearEfficiency, backlash | -, %, arcmin | geared actuators only                                                                                                                 |
| ironLoss                        | model        | either a constant drag torque plus viscous coefficient, or loss at stated speeds; often unknown                                       |
| cogging                         | N·m          | peak; often unknown                                                                                                                   |
| rotorInertia                    | kg·m²        | at the motor; reflected through ratio by the app                                                                                      |
| thermalResistance               | K/W          | winding to ambient, **(basis)**                                                                                                       |
| thermalTimeConstant             | s            | winding; optionally a two-node pair (winding, case)                                                                                   |
| maxWindingTemperature           | °C           | insulation class if stated (the AK80-9 states class C)                                                                                |
| sensors                         | list         | Hall, encoder (bits), NTC type                                                                                                        |

**Controllers**

| Field                          | Unit | Notes                                                                                                        |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------ |
| busVoltage min, max (absolute) | V    | the absolute maximum, not the recommended; the check compares it to pack full voltage plus regenerative rise |
| continuousPhaseCurrent         | A    | **(basis)**: free air, heat spreader, forced air; at what bus voltage                                        |
| peakPhaseCurrent               | A    | with duration; may be a curve against bus voltage                                                            |
| busCurrentLimit                | A    | input side, both directions                                                                                  |
| power continuous, peak         | W    |                                                                                                              |
| regeneration                   | enum | to bus only; brake chopper on board; chopper output for an external resistor                                 |
| chopperCurrent                 | A    | if a chopper exists; minimum resistor value                                                                  |
| loopRate                       | Hz   | current loop; position or velocity loop if different                                                         |
| pwmFrequency                   | Hz   | range                                                                                                        |
| feedback                       | list | incremental, absolute SPI, RS-485, Hall, onboard magnetic (bits)                                             |
| communication                  | list | CAN, CAN-FD (rate), UART, USB, PWM, step and direction                                                       |
| maxElectricalFrequency         | Hz   | bounds pole pairs times speed (moteus-n1 states 2 kHz)                                                       |
| operatingTemperature           | °C   |                                                                                                              |
| firmwareLicense                | text | informational                                                                                                |

### T9.2c: Cells, packs and battery management

**Cells**

| Field                                   | Unit        | Notes                                                                                                 |
| --------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| chemistry                               | enum        | NMC, NCA, LFP, LCO, other                                                                             |
| format                                  | enum        | 18650, 21700, 26650, pouch, prismatic                                                                 |
| capacity typical, minimum               | Ah          | and energy in Wh if stated                                                                            |
| voltage nominal, charge, cutoff         | V           |                                                                                                       |
| chargeCurrent standard, maximum         | A           | maximum with its **(basis)** (for example a 70 °C cutoff)                                             |
| continuousDischarge                     | A           | **(basis)**: the temperature cutoff it assumes (45 A at 80 °C for the P45B)                           |
| pulseDischarge                          | A, s        | if stated                                                                                             |
| impedanceAC                             | Ω           | at 1 kHz and stated SOC                                                                               |
| resistanceDC                            | Ω           | stated SOC and pulse length; the simulation uses this                                                 |
| ocvCurve                                | table       | open-circuit voltage against state of charge; a generic per-chemistry default allowed, marked as such |
| chargeTemperature, dischargeTemperature | °C range    |                                                                                                       |
| cycleLife                               | cycles to % | with its conditions                                                                                   |
| mass, diameter, height                  | g, mm       | maxima if stated                                                                                      |
| certifications                          | list        | UN 38.3, IEC 62133-2 as claimed by the maker (informational only)                                     |

**Pack (built in the app from cells)**

| Field                                                                                                                  | Unit      | Notes                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| cell                                                                                                                   | reference |                                                                                                                                        |
| series, parallel                                                                                                       | count     |                                                                                                                                        |
| interconnectResistance                                                                                                 | Ω         | per joint or total                                                                                                                     |
| enclosureMass                                                                                                          | g         | plus interconnects and wiring                                                                                                          |
| derived: nominal, full and empty voltage; energy (Wh); mass; internal resistance; continuous and charge current limits |           | the 100 Wh requirement reads energy from here; energy uses nominal voltage times rated capacity, which is how airline rules compute it |

**BMS**

| Field                               | Unit     | Notes                                                                                          |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| cellCount min, max                  | count    |                                                                                                |
| continuousCurrent discharge, charge | A        | separately; regeneration counts as charge                                                      |
| peakCurrent                         | A, s     |                                                                                                |
| protections                         | list     | over and under voltage per cell, over current, short circuit (with response time), temperature |
| balancing                           | enum, mA | passive or active; current                                                                     |
| standbyCurrent                      | µA       | drains the pack in storage                                                                     |
| communication                       | list     | SMBus, CAN, UART, none                                                                         |

### T9.2d: Bearings, belts and pulleys, gears, rope and cable

**Bearings**

| Field                         | Unit  | Notes                                              |
| ----------------------------- | ----- | -------------------------------------------------- |
| type                          | enum  | deep groove ball, angular contact, needle, bushing |
| d, D, B                       | mm    |                                                    |
| C (dynamic), C0 (static)      | kN    |                                                    |
| Pu (fatigue limit)            | kN    | for the extended life method                       |
| limitingSpeed, referenceSpeed | r/min | limiting speed depends on closure                  |
| closure                       | enum  | open, shield (Z, 2Z), contact seal (RS, 2RS, 2RSH) |
| clearance                     | enum  | C2, CN, C3                                         |
| calculation factors           | -     | kr, f0, where the maker gives them (SKF does)      |

**Belts and pulleys**

| Field                                                   | Unit               | Notes                                                    |
| ------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| profile                                                 | enum               | GT2/2MGT, 3MGT, 5MGT, HTD 3M, HTD 5M, HTD 8M, T, MXL, XL |
| pitch                                                   | mm                 |                                                          |
| width                                                   | mm                 |                                                          |
| ratedWorkingTension                                     | N, by groove count | a table, as Gates publishes it; interpolate              |
| minimumBreakingStrength                                 | N                  |                                                          |
| tensileModulus                                          | N per unit strain  | Gates gives tension for 0.1% elongation                  |
| cord                                                    | enum               | fibreglass, aramid, steel, carbon                        |
| minimumPulleyGrooves                                    | count              |                                                          |
| length (endless)                                        | mm or teeth        |                                                          |
| pulley: grooves, pitch diameter, bore, flange, material |                    | pitch diameter derived from grooves and pitch            |

**Gears**

| Field              | Unit                 | Notes                                                    |
| ------------------ | -------------------- | -------------------------------------------------------- |
| module             | mm                   |                                                          |
| teeth              | count                |                                                          |
| pressureAngle      | °                    |                                                          |
| faceWidth          | mm                   |                                                          |
| helixAngle         | °                    | zero for spur                                            |
| material, hardness | reference, HB or HRC | for AGMA simplified bending and contact                  |
| quality            | grade                | ISO 1328 or AGMA                                         |
| ratedTorque        | N·m                  | if the maker states one (moulded plastic gears often do) |

**Rope and cable**

| Field                                    | Unit   | Notes                                                                                            |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| material                                 | enum   | HMPE (Dyneema, Spectra), aramid (Kevlar), polyester, steel 7x7, steel 7x19, steel-core composite |
| construction                             | text   | 12-strand braid, cover and core, 7x19                                                            |
| diameter                                 | mm     |                                                                                                  |
| breakingLoad average, minimum            | N      | the check uses minimum                                                                           |
| terminationEfficiency                    | %      | splice, knot, swage; default by type, marked estimated                                           |
| minimumBendRatio, suggestedBendRatio     | D/d    | 8 and 10 for braided HMPE (Marlow); 34 and 51 for 7x19 steel                                     |
| elongation at a stated fraction of break | %      |                                                                                                  |
| creep note                               | text   | HMPE                                                                                             |
| massPerLength                            | g/m    | for wound mass and inertia                                                                       |
| designFactor default                     | -      | 7 for synthetic rope per Marlow's note; user may change                                          |
| cycleRating                              | cycles | if published (Speediance claims 50,000)                                                          |
| fatigue note                             | text   |                                                                                                  |

### T9.2e: Wire, connectors, fuses, switches, resistors

**Wire**

| Field               | Unit             | Notes                                                                      |
| ------------------- | ---------------- | -------------------------------------------------------------------------- |
| gauge               | AWG or mm²       | both shown                                                                 |
| strands             | count × diameter | silicone fine-strand versus building wire                                  |
| resistancePerLength | Ω/m at 20 °C     |                                                                            |
| insulation          | enum, °C         | PVC 80 or 105, silicone 200, PTFE                                          |
| voltageRating       | V                |                                                                            |
| ampacity            | A                | **(basis)**: standard, ambient, bundling; or computed from a thermal model |
| outerDiameter       | mm               | for harness bundles                                                        |

**Connectors**

| Field             | Unit        | Notes                                                                     |
| ----------------- | ----------- | ------------------------------------------------------------------------- |
| family, poles     | text, count |                                                                           |
| continuousCurrent | A           | **(basis)**: test duration and temperature rise (Amass: 4 h, under 60 °C) |
| burstCurrent      | A, s        |                                                                           |
| voltageRating     | V           |                                                                           |
| contactResistance | Ω           |                                                                           |
| matingCycles      | count       |                                                                           |
| wireRange         | AWG         |                                                                           |
| temperatureRange  | °C          |                                                                           |
| antiSpark         | boolean     | pre-charge resistor contact, as in XT90-S                                 |

**Fuses**

| Field              | Unit           | Notes                                         |
| ------------------ | -------------- | --------------------------------------------- |
| rating             | A              |                                               |
| voltageRating DC   | V              | must exceed pack full voltage                 |
| interruptingRating | A at V         | must exceed prospective short-circuit current |
| timeCurrent        | curve or class | percent of rating against opening time        |
| format             | enum           | ATO, MINI, MAXI, MIDI, ANL, cartridge, PCB    |
| I²t                | A²s            | for coordination with wire and MOSFETs        |

**Switches and contactors**

| Field                                     | Unit   | Notes                                        |
| ----------------------------------------- | ------ | -------------------------------------------- |
| kind                                      | enum   | toggle, rocker, push, contactor, solid-state |
| current continuous, making, breaking (DC) | A      | DC breaking is far below AC on the same part |
| voltageRating DC                          | V      |                                              |
| coil voltage and power                    | V, W   | contactors                                   |
| mechanical and electrical life            | cycles |                                              |

**Braking resistors**

| Field                 | Unit                | Notes                                             |
| --------------------- | ------------------- | ------------------------------------------------- |
| resistance            | Ω                   |                                                   |
| continuousPower       | W                   | **(basis)**: free air, moving air, on a heat sink |
| pulseEnergy           | J for a stated time | or a pulse derating curve                         |
| thermalTimeConstant   | s                   |                                                   |
| maxSurfaceTemperature | °C                  | for the touch-temperature check                   |
| voltageRating         | V                   |                                                   |

## 4. Standards a builder should know about

Names and scopes only, from the publishers' catalogue pages and test-house summaries. manufakture does not claim compliance with any of them (plan decision 1).

| Standard                                                                                                                                                                                                                                                                  | Scope (paraphrased)                                                                                                                                                                                                                                                                                             | Why it matters here                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISO 20957-1 (third edition, 2024) ([ISO catalogue](https://www.iso.org/standard/81908.html))                                                                                                                                                                              | General safety requirements and test methods for indoor stationary training equipment, with a classification by use (H domestic; S and I for supervised and institutional training areas) and by accuracy; covers motor-driven equipment, stability, edges, squeeze and shear points, markings and instructions | The general standard a cable trainer would be assessed against                                                                                                                                             |
| ISO 20957-2 (2020, listed as withdrawn by a catalogue summary; an EN ISO 20957-2:2024 appears in the [SIST catalogue](https://standards.iteh.ai/catalog/standards/sist/aca6475b-0a81-4173-bffb-8ceee0ff8eed/sist-en-iso-20957-2-2024))                                    | Additional requirements for strength training equipment, including resistance by "electrical, magnetic" and other means, read together with part 1                                                                                                                                                              | The part that names electrically generated resistance; check which edition is current before relying on it                                                                                                 |
| Other ISO 20957 parts (for example part 6, treadmills; part 7, rowing)                                                                                                                                                                                                    | Equipment-specific additions                                                                                                                                                                                                                                                                                    | Rowing and ski modes resemble part 7's equipment (not checked further)                                                                                                                                     |
| IEC 60335-1 ([IECEE](https://www.iecee.org/certification/iec-standards/iec-60335-12020))                                                                                                                                                                                  | Safety of household and similar electrical appliances: shock, heat, mechanical hazards, fire, abnormal operation; always used with a part 2                                                                                                                                                                     | The electrical safety baseline for a domestic appliance in many markets                                                                                                                                    |
| IEC 60335-2-XX, stationary training appliances ([BSI project page](https://standardsdevelopment.bsigroup.com/projects/9021-05795))                                                                                                                                        | A new part for electric stationary training appliances up to 250 V, such as treadmills (project PNW 61-6307, status not checked)                                                                                                                                                                                | Would be the specific part for this kind of machine once published                                                                                                                                         |
| UL 1647 ([UL catalogue](https://standardscatalog.ul.com/standards/en/standard_1647))                                                                                                                                                                                      | Motor-operated massage and exercise machines up to 250 V (North America)                                                                                                                                                                                                                                        | The North American counterpart for motorised exercise machines                                                                                                                                             |
| IEC 62133-2 (2017, amended 2021) ([IECEE](https://www.iecee.org/certification/iec-standards/iec-62133-22017))                                                                                                                                                             | Safety of portable sealed secondary lithium cells and batteries under intended use and reasonably foreseeable misuse                                                                                                                                                                                            | Cell and pack safety; makers often claim it for cells, and the pack needs its own assessment                                                                                                               |
| UN 38.3 (UN Manual of Tests and Criteria, part III, section 38.3) ([TÜV SÜD](https://www.tuvsud.com/en-us/industries/mobility-and-automotive/automotive-and-oem/automotive-testing-solutions/battery-testing/un-dot-38-3))                                                | Tests T1 to T8 for lithium cells and batteries before transport: altitude, thermal cycling, vibration, shock, external short circuit, impact or crush, overcharge, forced discharge                                                                                                                             | Required before a lithium battery, or a device containing one, can be shipped                                                                                                                              |
| IATA passenger rules for lithium batteries ([IATA](https://www.iata.org/en/youandiata/travelers/batteries/); [IATA passenger guidance, 2026-03-31](https://www.iata.org/contentassets/6fea26dd84d24b26a7a1fd5788561d6e/passengers_travelling_with_lithium_batteries.pdf)) | Lithium-ion batteries up to 100 Wh travel without airline approval; over 100 Wh up to 160 Wh need approval (at most two spares, cabin only); over 160 Wh are outside the passenger allowance                                                                                                                    | The source of the "under 100 Wh" requirement. Shipping as cargo also changes class at 100 Wh per battery under the Dangerous Goods Regulations (general knowledge, unverified against the current edition) |
| CISPR 14-1 ([IEC CISPR guide](https://assets.iec.ch/further_informations/1298/CISPR%20Guide%202024.pdf); [summary](https://www.atecorp.com/compliance-standards/iec-cispr/cispr-14-1))                                                                                    | Radio-frequency emissions from household appliances, electric tools and similar apparatus, mains or battery powered, including their motors and switching devices                                                                                                                                               | A PWM motor drive is a strong emitter; this is the emissions standard for the class                                                                                                                        |
| CISPR 14-2                                                                                                                                                                                                                                                                | Immunity of the same apparatus                                                                                                                                                                                                                                                                                  | Pairs with 14-1                                                                                                                                                                                            |
| IEC 61000 family (for example 61000-3-2 harmonics for equipment up to 16 A per phase, 61000-3-3 flicker, 61000-4-x immunity tests such as ESD)                                                                                                                            | Basic and product-family EMC limits and test methods                                                                                                                                                                                                                                                            | Applies to the charger and anything mains-connected; the 61000-4 tests are referenced by CISPR 14-2                                                                                                        |
| Radio (not researched)                                                                                                                                                                                                                                                    | Bluetooth and Wi-Fi radios fall under radio-equipment rules in each market                                                                                                                                                                                                                                      | The Voltra has both; a builder adding a radio inherits these                                                                                                                                               |

## 5. Drafted requirement list for the scenario (T9.11a)

Each requirement names where its number came from. "Published" means a figure in section 1; "estimated" means derived or chosen here and open to the maintainer's change. T9.4a turns these into requirement records.

| Id  | Requirement                          | Target                                                                                                                                                                                                                                                                                  | Origin                                                                                                    |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R1  | Force range at the handle            | 5 to 200 lbf (22.2 to 890 N)                                                                                                                                                                                                                                                            | Published: Voltra I                                                                                       |
| R2  | Force step                           | 1 lbf (4.45 N)                                                                                                                                                                                                                                                                          | Published: Voltra I guide and Speediance; Voltra product page not confirmed                               |
| R3  | Force accuracy                       | within 1 lbf or 2% of setting, whichever is larger, across the full payout                                                                                                                                                                                                              | Estimated: no machine publishes accuracy; ISO 20957-1 has accuracy classes whose values were not read     |
| R4  | Cable travel                         | 2.85 m from the fairlead                                                                                                                                                                                                                                                                | Published: Voltra help centre (the product page says 2.6 m; the scenario should state which it means)     |
| R5  | Cable diameter and kind              | 3 mm synthetic fibre; rope check at a design factor of 7 on terminated strength                                                                                                                                                                                                         | Published: Voltra (3 mm); factor from Marlow's HMPE note                                                  |
| R6  | Speed at full force                  | 1.5 m/s pull and return at 200 lbf                                                                                                                                                                                                                                                      | Estimated: the plan's "brisk pull"; no published figure for the Voltra                                    |
| R7  | Maximum cable speed at reduced force | 3 m/s at up to 50 lbf for rowing and ski modes                                                                                                                                                                                                                                          | Estimated: chosen as a target below the Gym Nano's published 6.4 m/s, which serves a heavier machine      |
| R8  | Isometric hold                       | 30 s at 200 lbf without exceeding winding or cell limits                                                                                                                                                                                                                                | Estimated: the plan's holding case                                                                        |
| R9  | Sessions per charge                  | at least 6 sessions of 13 sets × 9 reps at 100 lbf over a 0.6 m stroke with 60 s rests; at least 14 at 60 lbf                                                                                                                                                                           | Published: Voltra help centre (6 and 14 sessions); set, rep and stroke assumptions estimated              |
| R10 | Pack energy                          | under 100 Wh (nominal voltage × rated capacity)                                                                                                                                                                                                                                         | Published threshold: IATA; Voltra 97.9 Wh, Gym Nano 95.68 Wh                                              |
| R11 | Charging                             | USB-C PD input up to 140 W; full charge within 2 h 30 min at 65 W                                                                                                                                                                                                                       | Published: Voltra (140 W; 2 h at 65 W, unverified wording)                                                |
| R12 | Mass                                 | at most 6.0 kg                                                                                                                                                                                                                                                                          | Published: Voltra 5.8 kg, rounded up                                                                      |
| R13 | Envelope                             | within 330 × 140 × 100 mm                                                                                                                                                                                                                                                               | Published: Voltra 323 × 139 × 100 mm, rounded                                                             |
| R14 | Operating temperature                | 0 to 40 °C ambient                                                                                                                                                                                                                                                                      | Published: Voltra                                                                                         |
| R15 | Modes                                | constant force with eccentric overload (up to +30% on return), band (force rising linearly with extension), chains (force rising with height), damper (force proportional to speed), isokinetic (fixed speed), isometric (hold and peak force test), custom force curve, rowing, skiing | Published: Voltra mode list; chains from Tonal and Speediance; 30% from a coach quoted in a Voltra review |
| R16 | Fault response                       | on any fault the handle force ramps down to zero, never steps up, within a time the control specification states (estimated 100 ms); cable never retracts faster than a set limit                                                                                                       | Estimated: the plan's "never yanks the handle"; T9.9d sets the numbers                                    |
| R17 | Parts limits (derived)               | controller absolute maximum voltage above pack full voltage plus regenerative rise; fuse DC voltage rating above pack full voltage; regenerated power absorbed without charging cells above their maximum charge current                                                                | Estimated: from sections 2.2, 2.3 and 2.7                                                                 |
| R18 | Surface temperature                  | touchable housing surfaces below a limit the user sets (estimated default 60 °C)                                                                                                                                                                                                        | Estimated: IEC 60335-1 has touch-temperature limits whose values were not read                            |

In one line: 5 to 200 lbf in 1 lbf steps; 2.85 m of 3 mm fibre; 1.5 m/s at full force and 3 m/s light; a 30 s hold at 200 lbf; 6 sessions at 100 lbf and 14 at 60 lbf per charge; a pack under 100 Wh charged over 140 W USB-C; at most 6 kg in 330 × 140 × 100 mm; 0 to 40 °C; nine modes; safe ramp-down on fault.

## 6. Gaps and follow-ups

- **No cable speed for the Voltra,** and no published force accuracy for any machine. R6, R7 and R3 are estimates; the maintainer may want to set them.
- **The Voltra's cable length conflict** (2.6 m against 2.85 m) is unresolved. A purchase or a teardown would settle it; so would asking the maker.
- **Pack layout and cell** of either battery machine are not published; 16S and 13S are inferences.
- **Motor thermal data** (thermal resistance, time constant, maximum winding temperature, iron loss) was not found for any motor read. Catalog entries will carry them as unknown or estimated, and T9.0b's spike should say which values it assumed.
- **SKF tables** could not be read from SKF's own pages (script-rendered); bearing values here are from distributors and a catalogue mirror and stay unverified. The 6001-2RSH limiting speed in particular looks high.
- **Several secondary sources:** the Samsung 40T and 30Q, Molicel P28A, the Flipsky 75100, Tonal's mass, the AEKE K1 and the Gym Monster 2 are from distributors, reviews or search summaries.
- **Standards were not read.** Accuracy classes (ISO 20957-1) and touch-temperature limits (IEC 60335-1) are referred to by name only; whoever owns the product decides whether to buy and read them. The IEC 60335 part for training appliances was a project at the time of the source.
- **No small high-rate cell** (about 1.7 Ah, under 6.1 Wh) was researched, though the Voltra's pack implies one. T9.2c should add one so the sizing study can reach a 16S pack under 100 Wh.
- **A larger direct-drive motor** (about 20 N·m continuous in a 100 mm tall box) was not found; whether one exists at hobby prices decides direct drive against a reduction. The CubeMars RO100's electrical constants were not found either.

## Sources

Reference machines

- Beyond Power, VOLTRA I product page: https://www.beyond-power.com/products/voltra
- Beyond Power help centre, "How long is the cable?": https://help.beyond-power.com/en/articles/10124119-how-long-is-the-cable
- Hypertrophy Protocol, VOLTRA I guide: https://hypertrophyprotocol.com/lifting-protocols/beyond-power-voltra-guide/
- Gray Matter Lifting, VOLTRA I review: https://graymatterlifting.com/beyond-power-voltra-i-review/
- Speediance for Business, Gym Nano: https://business.speediance.com/gym-nano/
- AndroidGuys, Gym Nano announcement: https://androidguys.com/news/speediance-gym-nano-packs-220-pounds-of-resistance-into-a-carry-on-sized-gym/
- Rayofi, GoTone Pro vs VOLTRA I vs Gym Nano: https://rayofi.com/blogs/news/gotone-pro-vs-voltra-vs-speediance-gym-nano
- Tonal, "Experience the Future of Fitness with Tonal 2": https://tonal.com/blogs/all/experience-the-future-of-fitness-with-tonal-2
- Garage Gym Reviews, Tonal 2 review: https://www.garagegymreviews.com/tonal-review
- Vitruvian, hardware and electrical specifications: https://knowledge.vitruvianform.com/support/hardware-and-electrical-specifications
- GadgetGuy, Vitruvian Trainer+ review: https://www.gadgetguy.com.au/vitruvian-trainer-the-ultimate-home-gym-solution-review/
- Fitshop, Speediance Gym Monster 2: https://www.fitshop.co.uk/speediance-gym-monster-2-sp-gm2
- AEKE FAQ: https://aeke.com/pages/faq
- AEKE K1 manual summary: https://manuals.plus/asin/B0FR4WF6Q6

Motors and controllers

- ODrive documentation, ODrive motors: https://docs.odriverobotics.com/v/latest/hardware/odrive-motors.html
- ODrive S1 datasheet: https://docs.odriverobotics.com/v/latest/hardware/s1-datasheet.html
- ODrive Pro datasheet: https://docs.odriverobotics.com/v/latest/hardware/pro-datasheet.html
- ODrive shop, brake resistors: https://shop.odriverobotics.com/products/set-of-8-brake-resistors
- mjbots, mj5208: https://mjbots.com/products/mj5208
- mjbots, moteus-n1: https://mjbots.com/products/moteus-n1
- mjbots blog, "Representing torque constant as Kv in moteus": https://blog.mjbots.com/2025/04/17/representing-torque-constant-as-kv-in-moteus/
- CubeMars, AK80-9 V3.0: https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html
- CubeMars, RO100 KV55: https://www.cubemars.com/product/ro100-kv55-standard-with-hall-frameless-torque-motor.html
- iFlight, GM5208-24: https://shop.iflight.com/ipower-motor-gm5208-24-brushless-gimbal-motor-pro1347
- Flipsky, 75100 V2.0: https://theflipsky.com/product/flipsky-75100-v2-0-with-aluminum-pcb-with-power-switch-button-based-on-vesc-for-electric-skateboard-scooter-ebike-speed-controller/

Cells

- Molicel, INR-21700-P45B product data sheet v1.2: https://www.molicel.com/wp-content/uploads/INR21700P45B_1.2_Product-Data-Sheet-of-INR-21700-P45B-80109.pdf
- Molicel, INR-21700-P42A: https://www.molicel.com/product/inr-21700-p42a/
- NKON, Samsung INR21700-40T: https://www.nkon.nl/en/samsung-inr21700-40t5-4000mah-35a.html
- NKON, Molicel INR18650-P28A: https://www.nkon.nl/en/molicel-inr18650-p28a-2800mah-35a.html
- Samsung SDI, INR18650-30Q specification (copy): https://files.batteryjunction.com/frontend/files/samsung/datasheet/SAMSUNG-30Q-18650-3000-FLAT-Datasheet.pdf

Bearings, belts, rope and cable

- MRO Supply, SKF 6001-2RSH: https://www.mrosupply.com/bearings/319810_6001-2rsh_skf-bearing/
- SKF, 6004-2RSH: https://www.skf.com/au/products/rolling-bearings/ball-bearings/deep-groove-ball-bearings/productid-6004-2RSH
- bearingsize.info, SKF 6005-2RSH: https://bearingsize.info/catalogue-online/deep-groove-ball-bearings/bearing-6005-2rsh-skf-obj32488.html
- Gates, Light Power and Precision Drive Design Manual: https://www.gates.com/content/dam/documents-library/catalogs/light-power-and-precision-manual.pdf
- Rigging Warehouse, Samson AmSteel-Blue 7/64 in: https://www.riggingwarehouse.com/502-872007532830-samson-amsteel-blue-rigging-rope-7-64-x-280-green.html
- Marlow Ropes, HMPE tech talk 5 (working loads, D:d ratios): https://www.marlowropes.com/news/hmpe-tech-talk-5-working-loads-dd-rations-inspection-shelf-life/
- US Cargo Control, 3/32 in 7x19 galvanised aircraft cable: https://www.uscargocontrol.com/products/3-32-7x19-galvanized-wire-by-linear-foot
- Industrial Wire Rope Supply, sheave and drum ratios: https://industrialrope.com/wire-rope/sheave-and-drum-ratios/

Wire, connectors, fuses

- Wikipedia, American wire gauge: https://en.wikipedia.org/wiki/American_wire_gauge
- Holybro, connector and wire rating: https://docs.holybro.com/power-module-and-pdb/power-module/connector-and-wire-rating
- berrybase, AMASS XT60 male datasheet: https://www.berrybase.de/en/product-datasheet/0192afa30c5f70b7a5796f0d1be4af74/create
- Littelfuse, TAC ATO style blade fuse rated 58V: https://www.mouser.com/datasheet/2/240/Littelfuse-Automotive-Blade-Fuse-TAC-ATO-58V-23798.pdf

Standards and transport rules

- ISO 20957-1:2024: https://www.iso.org/standard/81908.html
- SIST EN ISO 20957-2:2024: https://standards.iteh.ai/catalog/standards/sist/aca6475b-0a81-4173-bffb-8ceee0ff8eed/sist-en-iso-20957-2-2024
- IECEE, IEC 60335-1:2020: https://www.iecee.org/certification/iec-standards/iec-60335-12020
- BSI, project for a stationary training appliances part of IEC 60335: https://standardsdevelopment.bsigroup.com/projects/9021-05795
- UL, UL 1647: https://standardscatalog.ul.com/standards/en/standard_1647
- IECEE, IEC 62133-2:2017: https://www.iecee.org/certification/iec-standards/iec-62133-22017
- TÜV SÜD, UN/DOT 38.3 testing: https://www.tuvsud.com/en-us/industries/mobility-and-automotive/automotive-and-oem/automotive-testing-solutions/battery-testing/un-dot-38-3
- IATA, safe travel with lithium batteries: https://www.iata.org/en/youandiata/travelers/batteries/
- IATA, passengers travelling with lithium batteries (2026-03-31): https://www.iata.org/contentassets/6fea26dd84d24b26a7a1fd5788561d6e/passengers_travelling_with_lithium_batteries.pdf
- IEC, CISPR guide 2024: https://assets.iec.ch/further_informations/1298/CISPR%20Guide%202024.pdf
- A.T.E., CISPR 14-1 summary: https://www.atecorp.com/compliance-standards/iec-cispr/cispr-14-1
