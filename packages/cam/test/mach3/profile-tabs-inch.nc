%
(Job: Plywood sign)
(Setup: Top)
(Posted 2026-10-02 for Mach3, inch)
(Zero X, Y and Z at: stock top, front left corner)
(Tools in this file: 1)
G91.1
(Tool 201: #201 1/4" flat end mill, diameter 0.25 inch)
G20 G90 G17 G94
(Tool 201: #201 1/4" flat end mill)
(Spindle 18000 rpm, cutting feed 39.4 inch/min)
M6 T201
G43 H201
G0 Z0.5906
(Router dial 3: 18250 rpm, nearest to 18000 rpm)
M3 S18000
(Profile: outline, outside, 2 passes, 2 tabs)
X1.1811 Y-0.125
Z0.1969
G1 Z-0.128 F11.8
X0 F39.4
G2 X-0.125 Y0 I0 J0.125
G1 Y1.5748
G2 X0 Y1.6998 I0.125 J0
G1 X2.3622
G2 X2.4872 Y1.5748 I0 J-0.125
G1 Y0
G2 X2.3622 Y-0.125 I-0.125 J0
G1 X1.1811
Z-0.2559 F11.8
X0.8533 F39.4
X0.814 Z-0.1772
X0.3671
X0.3278 Z-0.2559
X0
G2 X-0.125 Y0 I0 J0.125
G1 Y1.5748
G2 X0 Y1.6998 I0.125 J0
G1 X0.9183
X0.9577 Z-0.1772
X1.4045
X1.4439 Z-0.2559
X2.3622
G2 X2.4872 Y1.5748 I0 J-0.125
G1 Y0
G2 X2.3622 Y-0.125 I-0.125 J0
G1 X1.1811
G0 Z0.5906
M5
M30
%
