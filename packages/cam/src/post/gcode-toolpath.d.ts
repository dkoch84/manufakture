// Types for `gcode-toolpath` 3.0.0 (MIT, a development dependency for the post's round-trip
// test), which ships none. Only what the test uses. Positions are millimetres: the package
// converts G20 input to millimetres itself.

declare module 'gcode-toolpath' {
  interface Point {
    x: number;
    y: number;
    z: number;
  }
  interface Modal {
    motion: string;
    units: string;
    distance: string;
    plane: string;
  }
  interface ToolpathOptions {
    position?: Partial<Point>;
    addLine?: (modal: Modal, start: Point, end: Point) => void;
    addArcCurve?: (modal: Modal, start: Point, end: Point, center: Point) => void;
  }
  interface Interpreter {
    loadFromStringSync(text: string): void;
    getPosition(): Point;
    getModal(): Modal;
  }
  const Toolpath: new (options?: ToolpathOptions) => Interpreter;
  export default Toolpath;
}
