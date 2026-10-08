// CSV fields for the takeoff files every domain writes (the cut list, the bill of materials and
// the construction takeoff; RFC 4180), with the guard against spreadsheet formula injection on
// user-supplied text.

/** One CSV field, quoted when it needs to be (RFC 4180). */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A CSV field of user-supplied text: one that a spreadsheet would read as a formula (it starts
 * with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading `'`, so a part named
 * `=HYPERLINK(...)` stays text. Numbers and formatted measures do not pass through here, so a
 * negative number stays a number.
 */
export function csvTextField(value: string): string {
  return csvField(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}
