%
(Job: Plywood sign)
(Setup: Top)
(Posted 2026-10-02 for Mach3, mm)
(Zero X, Y and Z at: stock top, front left corner)
(Tools in this file: 1)
G91.1
(Tool 3: 3 mm drill, diameter 3 mm)
G21 G90 G17 G94
(Tool 3: 3 mm drill)
(Spindle 12000 rpm, cutting feed 150 mm/min)
M6 T3
G43 H3
G0 Z15
(Router dial 1: 11000 rpm, nearest to 12000 rpm)
M3 S12000
(Drill: 3 holes, 4 mm deep)
X70 Y35
Z5
Z1
G99 G81 X70 Y35 Z-4 R1 F150
G80
G0 Z5
X90
Z1
G99 G81 X90 Y35 Z-4 R1
G80
G0 Z5
X110
Z1
G99 G81 X110 Y35 Z-4 R1
G80
(Drill: 3 holes, 8 mm deep, 3 mm pecks)
G0 Z5
X10 Y10
Z1
G99 G83 X10 Y10 Z-8 R1 Q3
G80
G0 Z5
X50
Z1
G99 G83 X50 Y10 Z-8 R1 Q3
G80
G0 Z5
X30 Y30
Z1
G99 G83 X30 Y30 Z-8 R1 Q3
G80
G0 Z15
M5
M30
%
