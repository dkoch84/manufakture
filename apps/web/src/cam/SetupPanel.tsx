// The setup panel of the Manufacture workspace (M5 plan, T5.3a): the active setup's part and body,
// machine and post, stock (from the body's bounds with margins, or an explicit box) and material,
// the WCS (up axis or a picked planar face, origin corner and Z), and the heights. Machine numbers
// that were not checked against their source are marked. Every change is one `editCamSetup`, so
// one undo step; the stock and heights are drafts applied together.

import {
  CAM_UP_AXES,
  CAM_WCS_CORNERS,
  type CamSetup,
  type CamStock,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  FEED_CATEGORIES,
  MACHINES,
  findSpindle,
  unverifiedMachineFields,
  type MachineProfile,
} from '@manufakture/cam/library';
import type { CamGeometryResult } from '@manufakture/regen';
import { useMemo, useState } from 'react';
import { ExpressionField } from '../components/ExpressionField';
import type { Variables } from '../sketcher/values';
import {
  POST_IDS,
  editSetupCommand,
  machineById,
  machineCommand,
  postName,
  type SetupChanges,
} from './commands';
import { wcsLost } from './status';
import {
  MARGIN_KEYS,
  SIZE_KEYS,
  STOCK_FIELDS,
  buildStockAndHeights,
  storedFields,
  type StockKey,
} from './setupForms';
import { camVariables, validator } from './values';

export interface SetupPanelProps {
  doc: ManufaktureDocument;
  setup: CamSetup;
  /** Bodies of each part as the last regen made them: body id and display name. */
  bodiesOf: (partId: string) => readonly { id: string; name: string }[];
  geometry: CamGeometryResult | null;
  pickingWcs: boolean;
  onPickWcs: (on: boolean) => void;
  run: (command: Command, label: string) => boolean;
  disabled?: boolean;
}

const UP_LABELS: Readonly<Record<(typeof CAM_UP_AXES)[number], string>> = {
  '+z': 'Model +Z',
  '-z': 'Model -Z (part flipped)',
  '+y': 'Model +Y',
  '-y': 'Model -Y',
  '+x': 'Model +X',
  '-x': 'Model -X',
};

const CORNER_LABELS: Readonly<Record<(typeof CAM_WCS_CORNERS)[number], string>> = {
  'front-left': 'Front left',
  'front-right': 'Front right',
  'back-left': 'Back left',
  'back-right': 'Back right',
  centre: 'Centre',
};

/** Machines in picker order: the primary ones (the machines cut on) first, as the table lists them. */
const MACHINE_ORDER: readonly MachineProfile[] = [
  ...MACHINES.filter((m) => m.primary),
  ...MACHINES.filter((m) => !m.primary),
];

const FIELD_NAMES: Readonly<Record<string, string>> = {
  'travel.x': 'X travel',
  'travel.y': 'Y travel',
  'travel.z': 'Z travel',
  maxFeed: 'fastest feed',
  maxRapid: 'rapid rate',
  spindle: 'spindle',
  firmware: 'firmware',
  sender: 'sender',
  toolLengthSensor: 'tool length sensor',
  'spindle.rpmRange': 'spindle speed range',
  'spindle.dial': 'router dial speeds',
};

export function SetupPanel({
  doc,
  setup,
  bodiesOf,
  geometry,
  pickingWcs,
  onPickWcs,
  run,
  disabled = false,
}: SetupPanelProps) {
  // The name being typed, or null: the box shows the document's name (so an undo shows).
  const [draftName, setDraftName] = useState<string | null>(null);
  const machine = machineById(setup.machine);
  const variables = useMemo(() => camVariables(doc), [doc]);
  const edit = (changes: SetupChanges, label: string) =>
    run(editSetupCommand(setup.id, changes), label);
  const commitName = () => {
    if (draftName === null) return;
    const text = draftName.trim();
    setDraftName(null);
    if (text !== setup.name && text !== '') edit({ name: text }, 'Rename CAM setup');
  };
  // Feature ids are per part: another part has look-alike ids (`extrude#1`, `sketch#1`), so the
  // operations' faces, sketches and holes, and a WCS face, would resolve on it silently.
  const partLocked = setup.operations.length > 0 || setup.wcs.up.kind === 'face';
  const bodies = bodiesOf(setup.part);
  const lost = geometry?.setupId === setup.id ? wcsLost(geometry) : null;
  const unverified = machine ? unverifiedMachineFields(machine) : [];

  return (
    <div className="cam-setup" data-testid="cam-setup">
      <label className="print-field">
        <span>Name</span>
        <input
          type="text"
          data-testid="cam-setup-name"
          value={draftName ?? setup.name}
          disabled={disabled}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') setDraftName(null);
          }}
        />
      </label>
      <label className="print-field">
        <span>Part</span>
        <select
          data-testid="cam-setup-part"
          value={setup.part}
          disabled={disabled || partLocked}
          aria-describedby={partLocked ? 'cam-setup-part-note' : undefined}
          onChange={(e) => edit({ part: e.target.value, body: null }, 'Machine another part')}
        >
          {doc.parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {partLocked && (
        <p className="field-note" id="cam-setup-part-note" data-testid="cam-setup-part-note">
          {partLockReason(setup)} on this part: start a new setup to machine another part (and
          choose the part there).
        </p>
      )}
      {(bodies.length > 1 || setup.body !== undefined) && (
        <label className="print-field">
          <span>Body</span>
          <select
            data-testid="cam-setup-body"
            value={setup.body ?? ''}
            disabled={disabled || partLocked}
            aria-describedby={partLocked ? 'cam-setup-body-note' : undefined}
            onChange={(e) =>
              edit({ body: e.target.value === '' ? null : e.target.value }, 'Machine another body')
            }
          >
            <option value="">{bodies.length > 1 ? 'Not chosen' : 'The only body'}</option>
            {bodies.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {setup.body !== undefined && !bodies.some((b) => b.id === setup.body) && (
              <option value={setup.body}>{setup.body} (not found)</option>
            )}
          </select>
        </label>
      )}
      {partLocked && (bodies.length > 1 || setup.body !== undefined) && (
        <p className="field-note" id="cam-setup-body-note" data-testid="cam-setup-body-note">
          {bodyLockNote(setup)}
        </p>
      )}
      <label className="print-field">
        <span>Machine</span>
        <select
          data-testid="cam-setup-machine"
          value={setup.machine}
          disabled={disabled}
          onChange={(e) => {
            const next = machineById(e.target.value);
            if (next) run(machineCommand(setup, next), `Cut on ${next.name}`);
          }}
        >
          {!machine && <option value={setup.machine}>Unknown: {setup.machine}</option>}
          {MACHINE_ORDER.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {machine ? (
        <MachineSummary machine={machine} unverified={unverified} />
      ) : (
        <p className="field-error" role="alert" data-testid="cam-unknown-machine">
          This version does not know the machine {setup.machine}: nothing is generated for this
          setup until another machine is chosen.
        </p>
      )}
      <label className="print-field">
        <span>Post</span>
        <select
          data-testid="cam-setup-post"
          value={setup.post}
          disabled={disabled}
          onChange={(e) => edit({ post: e.target.value }, `Post for ${postName(e.target.value)}`)}
        >
          {!POST_IDS.includes(setup.post) && (
            <option value={setup.post}>Unknown: {setup.post}</option>
          )}
          {(machine
            ? [...machine.posts, ...POST_IDS.filter((p) => !machine.posts.includes(p))]
            : POST_IDS
          )
            .filter((p) => POST_IDS.includes(p))
            .map((p) => (
              <option key={p} value={p}>
                {postName(p)}
                {machine?.posts[0] === p ? ' (machine default)' : ''}
              </option>
            ))}
        </select>
      </label>
      <label className="print-field">
        <span>Material</span>
        <select
          data-testid="cam-setup-material"
          value={setup.stock.material ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const { material: _old, ...rest } = setup.stock;
            void _old;
            const stock: CamStock =
              e.target.value === '' ? rest : { ...rest, material: e.target.value };
            edit({ stock }, 'Change stock material');
          }}
        >
          <option value="">Not set (no feed presets)</option>
          {FEED_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {setup.stock.material !== undefined &&
            !FEED_CATEGORIES.some((c) => c.id === setup.stock.material) && (
              <option value={setup.stock.material}>Unknown: {setup.stock.material}</option>
            )}
        </select>
      </label>
      <Wcs
        setup={setup}
        disabled={disabled}
        pickingWcs={pickingWcs}
        onPickWcs={onPickWcs}
        edit={edit}
      />
      {lost && (
        <p className="field-error" role="alert" data-testid="cam-setup-error">
          {lost}
        </p>
      )}
      <StockAndHeights
        key={JSON.stringify([setup.stock, setup.heights])}
        setup={setup}
        doc={doc}
        variables={variables}
        disabled={disabled}
        edit={edit}
      />
    </div>
  );
}

/**
 * Why the body select is locked, and the way out. A setup made while its part had one body names
 * no body, so neither do its faces; once the part has several, which of them the faces were picked
 * on cannot be told (the first body may have been split, deleted or rebuilt since), and a feature
 * that cut several bodies names its faces alike on each. Choosing a body then could machine a
 * look-alike without a word, so the lock stays and a new setup is the way out.
 */
function bodyLockNote(setup: CamSetup): string {
  if (setup.body === undefined) {
    return (
      `${partLockReason(setup)} on a body this setup never chose (the part had one body then): ` +
      'start a new setup, choose the body there, and add the operations again.'
    );
  }
  return `${partLockReason(setup)} on this body: start a new setup to machine another body (and choose the body there).`;
}

/** What ties a setup to its part: its operations, its WCS face, or both. */
function partLockReason(setup: CamSetup): string {
  const ops = setup.operations.length > 0;
  const face = setup.wcs.up.kind === 'face';
  if (ops && face) return "This setup's operations and WCS face are";
  return ops ? "This setup's operations are" : "This setup's WCS face is";
}

function MachineSummary({
  machine,
  unverified,
}: {
  machine: MachineProfile;
  unverified: readonly string[];
}) {
  const mark = (path: string) =>
    unverified.includes(path) ? (
      <span className="cam-unverified-mark" title="Not checked against the source">
        {' '}
        (unverified)
      </span>
    ) : null;
  const spindle = findSpindle(machine.spindle.value);
  return (
    <div className="cam-machine" data-testid="cam-machine-summary">
      <span>
        Travel {machine.travel.x.value} x {machine.travel.y.value} x {machine.travel.z.value} mm
        {mark('travel.x') ?? mark('travel.y') ?? mark('travel.z')}
      </span>
      <span>
        {spindle?.name ?? machine.spindle.value}
        {mark('spindle')}, {machine.firmware.value}
        {mark('firmware')}
      </span>
      {unverified.length > 0 && (
        <span className="cam-unverified" data-testid="cam-machine-unverified">
          Not checked against the maker&apos;s figures:{' '}
          {unverified.map((f) => FIELD_NAMES[f] ?? f).join(', ')}.
        </span>
      )}
    </div>
  );
}

function Wcs({
  setup,
  disabled,
  pickingWcs,
  onPickWcs,
  edit,
}: {
  setup: CamSetup;
  disabled: boolean;
  pickingWcs: boolean;
  onPickWcs: (on: boolean) => void;
  edit: (changes: SetupChanges, label: string) => boolean;
}) {
  const up = setup.wcs.up;
  return (
    <fieldset className="cam-wcs" data-testid="cam-wcs">
      <legend>Work coordinates</legend>
      <label className="print-field">
        <span>Up (machine +Z)</span>
        <select
          data-testid="cam-wcs-up"
          value={up.kind === 'axis' ? up.axis : 'face'}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === 'face') {
              onPickWcs(true);
              return;
            }
            edit(
              {
                wcs: {
                  ...setup.wcs,
                  up: { kind: 'axis', axis: e.target.value as (typeof CAM_UP_AXES)[number] },
                },
              },
              'Change the WCS up direction',
            );
          }}
        >
          {CAM_UP_AXES.map((a) => (
            <option key={a} value={a}>
              {UP_LABELS[a]}
            </option>
          ))}
          <option value="face">
            {up.kind === 'face' ? `Face ${up.face.ref.face}` : 'A planar face...'}
          </option>
        </select>
      </label>
      <button
        type="button"
        aria-pressed={pickingWcs}
        data-testid="cam-wcs-pick"
        disabled={disabled}
        onClick={() => onPickWcs(!pickingWcs)}
      >
        {pickingWcs ? 'Picking: click a planar face in the view' : 'Pick a face as up'}
      </button>
      <label className="print-field">
        <span>Origin</span>
        <select
          data-testid="cam-wcs-corner"
          value={setup.wcs.origin.xy}
          disabled={disabled}
          onChange={(e) =>
            edit(
              {
                wcs: {
                  ...setup.wcs,
                  origin: {
                    ...setup.wcs.origin,
                    xy: e.target.value as (typeof CAM_WCS_CORNERS)[number],
                  },
                },
              },
              'Move the WCS origin',
            )
          }
        >
          {CAM_WCS_CORNERS.map((c) => (
            <option key={c} value={c}>
              {CORNER_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="print-field">
        <span>Z zero</span>
        <select
          data-testid="cam-wcs-z"
          value={setup.wcs.origin.z}
          disabled={disabled}
          onChange={(e) =>
            edit(
              {
                wcs: {
                  ...setup.wcs,
                  origin: { ...setup.wcs.origin, z: e.target.value as 'top' | 'bottom' },
                },
              },
              'Move the WCS origin',
            )
          }
        >
          <option value="top">Stock top</option>
          <option value="bottom">Stock bottom (spoilboard)</option>
        </select>
      </label>
      <WcsGizmo corner={setup.wcs.origin.xy} z={setup.wcs.origin.z} />
    </fieldset>
  );
}

/**
 * A small diagram of where the origin sits: the stock seen from above (operator in front, at the
 * bottom) and from the front, with the origin and the machine X, Y and Z arrows.
 */
export function WcsGizmo({
  corner,
  z,
}: {
  corner: (typeof CAM_WCS_CORNERS)[number];
  z: 'top' | 'bottom';
}) {
  const x0 = 14;
  const x1 = 84;
  const y0 = 10;
  const y1 = 56;
  const ox = corner.endsWith('right') ? x1 : corner === 'centre' ? (x0 + x1) / 2 : x0;
  const oy = corner.startsWith('back') ? y0 : corner === 'centre' ? (y0 + y1) / 2 : y1;
  const sx0 = 110;
  const sx1 = 180;
  const sTop = 26;
  const sBottom = 46;
  const sz = z === 'top' ? sTop : sBottom;
  return (
    <svg
      className="cam-gizmo"
      viewBox="0 0 196 70"
      role="img"
      aria-label={`Origin at the ${CORNER_LABELS[corner].toLowerCase()} of the stock ${z === 'top' ? 'top' : 'bottom'}`}
      data-testid="cam-wcs-gizmo"
      data-corner={corner}
      data-z={z}
    >
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} className="cam-gizmo-stock" />
      <text x={(x0 + x1) / 2} y={68} textAnchor="middle" className="cam-gizmo-label">
        top view
      </text>
      <line x1={ox} y1={oy} x2={ox + 16} y2={oy} className="cam-gizmo-x" />
      <line x1={ox} y1={oy} x2={ox} y2={oy - 16} className="cam-gizmo-y" />
      <circle cx={ox} cy={oy} r={3} className="cam-gizmo-origin" />
      <rect
        x={sx0}
        y={sTop}
        width={sx1 - sx0}
        height={sBottom - sTop}
        className="cam-gizmo-stock"
      />
      <text x={(sx0 + sx1) / 2} y={68} textAnchor="middle" className="cam-gizmo-label">
        front view
      </text>
      <line
        x1={(sx0 + sx1) / 2}
        y1={sz}
        x2={(sx0 + sx1) / 2}
        y2={sz - 18}
        className="cam-gizmo-z"
      />
      <circle cx={(sx0 + sx1) / 2} cy={sz} r={3} className="cam-gizmo-origin" />
    </svg>
  );
}

function StockAndHeights({
  setup,
  doc,
  variables,
  disabled,
  edit,
}: {
  setup: CamSetup;
  doc: ManufaktureDocument;
  variables: Variables;
  disabled: boolean;
  edit: (changes: SetupChanges, label: string) => boolean;
}) {
  const units = doc.units;
  const initial = useMemo(() => {
    const stored = storedFields(setup);
    const out = {} as Record<StockKey, string>;
    for (const k of Object.keys(STOCK_FIELDS) as StockKey[]) {
      // A stock of a given size starts empty (the part's size is not known here); offsets and
      // margins at zero.
      out[k] = stored[k]?.source ?? (k.startsWith('size') ? '' : '0 mm');
    }
    return out;
  }, [setup]);
  const [kind, setKind] = useState<CamStock['kind']>(setup.stock.kind);
  const [drafts, setDrafts] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const changed =
    kind !== setup.stock.kind ||
    (Object.keys(STOCK_FIELDS) as StockKey[]).some((k) => drafts[k] !== initial[k]);
  const apply = () => {
    const r = buildStockAndHeights(setup, kind, drafts, doc, variables);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    edit(r.changes, 'Change stock and heights');
  };
  const field = (k: StockKey) => (
    <ExpressionField
      key={k}
      label={STOCK_FIELDS[k].label}
      testId={`cam-stock-${k}`}
      value={drafts[k]}
      kind="length"
      units={units}
      variables={variables}
      validate={validator(STOCK_FIELDS[k].rule)}
      error={errors[k]}
      onChange={(value) => setDrafts((d) => ({ ...d, [k]: value }))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && changed) apply();
      }}
    />
  );
  return (
    <fieldset className="cam-stock" data-testid="cam-stock">
      <legend>Stock and heights</legend>
      <div className="cam-radios">
        <label className="dialog-check">
          <input
            type="radio"
            name="cam-stock-kind"
            data-testid="cam-stock-fromBody"
            checked={kind === 'fromBody'}
            disabled={disabled}
            onChange={() => setKind('fromBody')}
          />
          The part&apos;s box plus margins
        </label>
        <label className="dialog-check">
          <input
            type="radio"
            name="cam-stock-kind"
            data-testid="cam-stock-explicit"
            checked={kind === 'explicit'}
            disabled={disabled}
            onChange={() => setKind('explicit')}
          />
          A stock of a given size
        </label>
      </div>
      {(kind === 'fromBody' ? MARGIN_KEYS : SIZE_KEYS).map(field)}
      {field('clearance')}
      {field('retract')}
      <p className="field-note">
        Heights are above the WCS origin; rapids between operations go to the clearance height.
      </p>
      <button
        type="button"
        className="primary"
        data-testid="cam-stock-apply"
        disabled={disabled || !changed}
        onClick={apply}
      >
        Apply stock and heights
      </button>
    </fieldset>
  );
}
