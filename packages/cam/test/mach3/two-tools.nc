%
(Job: Plywood sign)
(Setup: Top)
(Posted 2026-10-02 for Mach3, mm)
(Zero X, Y and Z at: stock top, front left corner)
(Tools in this file: 2)
G91.1
(Tool 201: #201 1/4" flat end mill, diameter 6.35 mm)
(Tool 2: #302 60 deg V-bit, diameter 12.7 mm)
G21 G90 G17 G94
(Tool 201: #201 1/4" flat end mill)
(Spindle 18000 rpm, cutting feed 1000 mm/min)
M6 T201
G43 H201
G0 Z15
(Router dial 3: 18250 rpm, nearest to 18000 rpm)
M3 S18000
(Profile: outline, outside, 2 passes, 2 tabs)
X30 Y-3.175
Z5
G1 Z-3.25 F300
X0 F1000
G2 X-3.175 Y0 I0 J3.175
G1 Y40
G2 X0 Y43.175 I3.175 J0
G1 X60
G2 X63.175 Y40 I0 J-3.175
G1 Y0
G2 X60 Y-3.175 I-3.175 J0
G1 X30
Z-6.5 F300
X21.675 F1000
X20.675 Z-4.5
X9.325
X8.325 Z-6.5
X0
G2 X-3.175 Y0 I0 J3.175
G1 Y40
G2 X0 Y43.175 I3.175 J0
G1 X23.325
X24.325 Z-4.5
X35.675
X36.675 Z-6.5
X60
G2 X63.175 Y40 I0 J-3.175
G1 Y0
G2 X60 Y-3.175 I-3.175 J0
G1 X30
G0 Z15
M5
(Next: #302 60 deg V-bit)
(Tool 2: #302 60 deg V-bit)
(Spindle 24500 rpm, cutting feed 800 mm/min)
M6 T2
G43 H2
G0 Z15
(Router dial 4: 24500 rpm)
M3 S24500
(V-carve: line and arc, 1 mm deep)
X10 Y20
Z5
G1 Z-1 F200
X25 F800
G2 X35 Y20 I5 J0
G1 X50
G0 Z15
M5
M30
%
