// The setup sheet (M5 plan, T5.4e): a printable HTML page with what the operator needs at the
// machine: the files and their order, the stock and where to zero X, Y and Z, the heights, the
// tools with their numbers, every tool change in order, and per operation its depths and feeds.
// Built as one self-contained document (inline styles, no scripts, no outside resources), shown
// in the export dialog, printed from there and saved with the G-code.
//
// What it says about zeroing on a Shapeoko stays with what the machine profile and the cam
// README cite: the BitSetter is standard on the profiles that say so, Carbide Motion stops for
// the tool at each `M6`, and Grbl does not jog while held by an `M0`. Anything a probe's routine
// does is left to its own instructions.

import { postName } from '../commands';
import { formatMinutes } from '../preview/format';
import {
  MULTI_TOOL_LABELS,
  formatFeed,
  formatLength,
  formatSize,
  toolLabel,
  type ExportPlan,
} from './export';

/** Escape text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  facing: 'Facing',
  profile: 'Profile',
  pocket: 'Pocket',
  drill: 'Drill',
  vcarve: 'V-carve',
  vcarveClearing: 'V-carve floor clearing',
  surface3d: '3D surfacing',
};

const XY_WORDS: Readonly<Record<string, string>> = {
  'front-left': 'the front left corner of the stock (its smallest X and Y)',
  'front-right': 'the front right corner of the stock (largest X, smallest Y)',
  'back-left': 'the back left corner of the stock (smallest X, largest Y)',
  'back-right': 'the back right corner of the stock (its largest X and Y)',
  centre: 'the centre of the stock (halfway along X and along Y)',
};

/** The steps to set the work zero and to handle tool changes, as sentences. */
export function zeroingSteps(plan: ExportPlan): string[] {
  const { origin, machine, multiTool, toolChanges, settings } = plan;
  const steps = [
    'Fix the stock to the spoilboard with its edges square to the X and Y axes, clear of the toolpaths.',
    `Load ${toolChanges[0] ? toolLabel(toolChanges[0].tool) : 'the first tool'}.`,
    `Jog the tool tip over ${XY_WORDS[origin.xy]} and zero X and Y there.`,
    origin.z === 'top'
      ? 'Zero Z with the tool tip touching the top of the stock.'
      : 'Zero Z with the tool tip touching the spoilboard the stock sits on (the stock bottom).',
    'A touch probe (such as the BitZero) can set the zero instead, where its probing routine supports this origin; follow its own instructions.',
  ];
  if (toolChanges.length > 1) {
    if (multiTool === 'files') {
      steps.push(
        `The job is ${plan.files.length} files, one per tool: run them in order, change the tool between them and zero Z again on the same surface before the next file. X and Y stay as they are.`,
      );
    } else if (multiTool === 'pause') {
      steps.push(
        'At each M0 pause: turn the router off, change the tool, zero Z again (or keep the same stick-out), set the router dial, turn the router on and resume. Grbl does not jog while held by an M0, so zeroing Z there needs a sender that allows it.',
      );
    } else if (settings.post === 'carbide-motion' && machine.toolLengthSensor.value) {
      steps.push(
        `Carbide Motion stops at each M6 and asks for the tool. The ${machine.name} profile lists a BitSetter as standard: with it enabled, each tool is measured at the change, so Z is zeroed once. Without it, zero Z again after every change.`,
      );
    } else {
      steps.push(
        `Each M6 asks for the next tool. Unless the ${postName(settings.post)} controller measures tool lengths, zero Z again after every change.`,
      );
    }
  }
  return steps;
}

const css = `
body { font: 12px/1.4 system-ui, sans-serif; color: #1d232b; margin: 1.2rem; }
h1 { font-size: 1.3rem; margin: 0 0 0.2rem; }
h2 { font-size: 1rem; margin: 1rem 0 0.3rem; border-bottom: 1px solid #ccd3db; }
p.meta { margin: 0; color: #4a5562; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.15rem 0.4rem; border-bottom: 1px solid #e3e7ec; vertical-align: top; }
th { font-weight: 600; background: #f3f5f8; }
td.num { text-align: right; white-space: nowrap; }
ol, ul { margin: 0.2rem 0; padding-left: 1.4rem; }
.warn { color: #8a4b00; }
@media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

/** The setup sheet as a complete HTML document. */
export function setupSheetHtml(plan: ExportPlan): string {
  const u = plan.settings.units;
  const e = escapeHtml;
  const len = (v: number | null) => (v === null ? '-' : e(formatLength(v, u)));
  const minutes = plan.stats ? plan.stats.estimate.totalMinutes : null;
  const parts: string[] = [];
  parts.push(
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${e(`Setup sheet: ${plan.jobName} - ${plan.setupName}`)}</title>`,
    `<style>${css}</style></head><body>`,
    `<h1>Setup sheet: ${e(plan.jobName)} - ${e(plan.setupName)}</h1>`,
    `<p class="meta">${e(plan.date)} | ${e(plan.machine.name)} | Post: ${e(plan.postName)} | Units: ${u === 'inch' ? 'inch (G20)' : 'mm (G21)'} | ${e(MULTI_TOOL_LABELS[plan.multiTool])}</p>`,
  );

  parts.push('<h2>Files</h2><ol data-sheet="files">');
  for (const f of plan.files) {
    const tools = f.tools
      .map((id) => plan.tools.find((t) => t.id === id))
      .filter((t) => t !== undefined)
      .map((t) => e(toolLabel(t)))
      .join(', ');
    parts.push(`<li>${e(f.name)}: ${tools}</li>`);
  }
  parts.push('</ol>');

  parts.push(
    '<h2>Stock and work zero</h2><table data-sheet="stock"><tbody>',
    `<tr><th>Stock size (X x Y x Z)</th><td>${e(formatSize(plan.stock.size, u))}</td></tr>`,
    `<tr><th>Material</th><td>${e(plan.stock.material ?? 'not set')}</td></tr>`,
    `<tr><th>Work zero (WCS origin)</th><td>${e(plan.origin.text)}</td></tr>`,
    `<tr><th>Clearance height</th><td>Z ${len(plan.heights.clearance)}</td></tr>`,
    `<tr><th>Retract height</th><td>Z ${len(plan.heights.retract)}</td></tr>`,
    '</tbody></table>',
    '<ol data-sheet="zeroing">',
    ...zeroingSteps(plan).map((s) => `<li>${e(s)}</li>`),
    '</ol>',
  );

  parts.push(
    '<h2>Tools</h2><table data-sheet="tools"><thead><tr><th>Number</th><th>Tool</th><th>Diameter</th><th>Flutes</th><th>Operations</th></tr></thead><tbody>',
  );
  for (const t of plan.tools) {
    parts.push(
      `<tr><td>${t.number !== undefined ? `T${t.number}` : 'none'}</td><td>${e(t.name)}</td><td class="num">${len(t.diameter)}</td><td class="num">${t.flutes}</td><td>${e(t.operations.join(', '))}</td></tr>`,
    );
  }
  parts.push('</tbody></table>');

  parts.push(`<h2>Tool changes (${plan.toolChanges.length})</h2><ol data-sheet="tool-changes">`);
  for (const c of plan.toolChanges) {
    const file = plan.files.length > 1 ? ` (file ${c.file} of ${plan.files.length})` : '';
    const speed = `${c.rpm} rpm${c.dial ? `; ${c.dial}` : ''}`;
    parts.push(
      `<li data-tool-change="${c.index}">${c.index === 1 ? 'Load' : 'Change to'} ${e(toolLabel(c.tool))} for ${e(c.operation)}${e(file)}: ${e(speed)}</li>`,
    );
  }
  parts.push('</ol>');

  parts.push(
    '<h2>Operations</h2><table data-sheet="operations"><thead><tr><th>#</th><th>Operation</th><th>Tool</th><th>Z top</th><th>Z bottom</th><th>Stepdown</th><th>Spindle</th><th>Cut feed</th><th>Plunge feed</th><th>Time</th></tr></thead><tbody>',
  );
  plan.operations.forEach((op, i) => {
    const kind = KIND_LABELS[op.kind] ?? op.kind;
    parts.push(
      `<tr data-operation="${e(op.id)}"><td>${i + 1}</td><td>${e(op.name)} (${e(kind)})${op.through ? ' <em>through</em>' : ''}</td><td>${e(toolLabel(op.tool))}</td>` +
        `<td class="num">${len(op.zTop)}</td><td class="num">${len(op.zBottom)}</td><td class="num">${len(op.stepdown)}</td>` +
        `<td>${op.feeds.spindle} rpm${op.dial ? `<br>${e(op.dial)}` : ''}</td>` +
        `<td class="num">${e(formatFeed(op.feeds.cut, u))}</td><td class="num">${e(formatFeed(op.feeds.plunge, u))}</td>` +
        `<td class="num">${op.minutes === null ? '-' : e(formatMinutes(op.minutes))}</td></tr>`,
    );
  });
  parts.push('</tbody></table>');

  parts.push(
    '<h2>Job</h2><table data-sheet="job"><tbody>',
    `<tr><th>Estimated time</th><td>${minutes === null ? '-' : e(formatMinutes(minutes))} (no acceleration or tool change time; a real machine takes longer)</td></tr>`,
    `<tr><th>Tool tip extents, X</th><td>${len(plan.extents.all.min[0])} to ${len(plan.extents.all.max[0])}</td></tr>`,
    `<tr><th>Tool tip extents, Y</th><td>${len(plan.extents.all.min[1])} to ${len(plan.extents.all.max[1])}</td></tr>`,
    `<tr><th>Tool tip extents, Z</th><td>${len(plan.extents.all.min[2])} to ${len(plan.extents.all.max[2])}</td></tr>`,
    '</tbody></table>',
  );
  if (plan.warnings.length > 0) {
    parts.push('<h2>Warnings</h2><ul data-sheet="warnings">');
    for (const w of plan.warnings) parts.push(`<li class="warn">${e(w)}</li>`);
    parts.push('</ul>');
  }
  parts.push('</body></html>');
  return parts.join('\n') + '\n';
}
