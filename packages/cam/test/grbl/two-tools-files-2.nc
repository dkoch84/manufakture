(Job: Plywood sign)
(Setup: Top)
(Posted 2026-10-02 for Grbl 1.1, mm, file 2 of 2)
(Zero X, Y and Z at: stock top, front left corner)
(Tools in this file: 1)
(Tool 302: #302 60 deg V-bit, diameter 12.7 mm)
G21 G90 G17 G94
(Next: #302 60 deg V-bit)
(Tool 302: #302 60 deg V-bit)
(Spindle 24500 rpm, cutting feed 800 mm/min)
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
