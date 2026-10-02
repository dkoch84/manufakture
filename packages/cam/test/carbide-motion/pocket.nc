(Job: Plywood sign)
(Setup: Top)
(Posted 2026-10-02 for Carbide Motion, mm)
(Zero X, Y and Z at: stock top, front left corner)
(Tools in this file: 1)
(TOOL 201: #201 1/4" flat end mill, diameter 6.35 mm)
G21 G90 G17
(TOOL 201: #201 1/4" flat end mill)
(Spindle 18000 rpm, cutting feed 1000 mm/min)
M6 T201
G0 Z15
M3 S18000
(Pocket: 40 x 30 mm, 3 mm deep, helical entry)
X102 Y15
Z5
Z1
G3 X98 Y15 Z0.5 I-2 J0 F300
G3 X102 Y15 Z0 I2 J0
G3 X98 Y15 Z-0.5 I-2 J0
G3 X102 Y15 Z-1 I2 J0
G3 X98 Y15 Z-1.5 I-2 J0
G3 X102 Y15 Z-2 I2 J0
G3 X98 Y15 Z-2.5 I-2 J0
G3 X102 Y15 Z-3 I2 J0
G3 X98 Y15 I-2 J0 F1000
G3 X102 Y15 I2 J0
G1 X109.325
Y19.325
X90.675
Y10.675
X109.325
Y15
X111.825
Y21.825
X88.175
Y8.175
X111.825
Y15
X114.325
Y24.325
X85.675
Y5.675
X114.325
Y15
X116.825
Y26.825
X83.175
Y3.175
X116.825
Y15
G0 Z15
M5
M30
