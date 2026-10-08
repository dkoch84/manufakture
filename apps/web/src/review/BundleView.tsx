// The sections of a review bundle, geometry first (ADR 0016 decision 11, against review fatigue):
// renders of base and head side by side, measurement deltas, new regen errors, quantity deltas,
// then the feature, document, domain and script diffs, and the command list with each command's
// JSON one click away. The scripts are the branch head's, not the bundle's (`branchScripts`): what
// **Run scripts** allows is what the reviewer reads, and hidden characters in them are found here.
// Every other value comes from the bundle, which is untrusted: it is read through `list`, `text`,
// `num` and `obj`, shown as React text, cut with `Clipped`, and listed a page at a time with
// `Paged`. Each section is `Guarded`, so one malformed part shows as such and the rest still reads.

import { useState } from 'react';
import type { ReviewBundle } from '@manufakture/review/data';
import { Clipped, Guarded, Paged } from './Bounded';
import { ReviewImage } from './ReviewImage';
import { count, list, num, obj, shownNumber, text, type ShownScript } from './review';

type Read = (sha256: string) => Promise<Uint8Array | null>;

const signed = (x: number | null): string =>
  x === null ? 'none' : `${x > 0 ? '+' : ''}${shownNumber(x)}`;

function Renders({ bundle, read }: { bundle: ReviewBundle; read: Read }) {
  const views = list(bundle.renders).slice(0, 8).map(obj);
  if (views.length === 0) return <p className="field-note">The bundle has no renders.</p>;
  return (
    <div className="review-renders" data-testid="review-renders">
      {views.map((v, i) => {
        const name = text(v.name).slice(0, 80) || `View ${i + 1}`;
        return (
          <figure key={i} className="review-render" data-testid={`review-render-${i}`}>
            <figcaption>{name}</figcaption>
            <div className="review-render-pair">
              <div>
                <span className="review-side">Base</span>
                <ReviewImage
                  value={v.base}
                  missing={v.baseError}
                  alt={`${name}, base`}
                  read={read}
                  testId={`review-image-${i}-base`}
                />
              </div>
              <div>
                <span className="review-side">Head</span>
                <ReviewImage
                  value={v.head}
                  missing={v.headError}
                  alt={`${name}, head`}
                  read={read}
                  testId={`review-image-${i}-head`}
                />
              </div>
            </div>
          </figure>
        );
      })}
    </div>
  );
}

function Measurements({ bundle }: { bundle: ReviewBundle }) {
  const m = obj(bundle.measurements);
  const bodies = obj(m.bodies);
  const items = list(bodies.items).map(obj);
  const interference = list(m.interference).map(obj);
  return (
    <>
      {items.length === 0 && <p className="field-note">No bodies were measured.</p>}
      {items.length > 0 && (
        <Paged
          items={items}
          omitted={count(bodies.omitted)}
          testId="review-bodies"
          render={(b) => {
            const head = obj(b.head);
            const base = obj(b.base);
            const delta = obj(b.delta);
            return (
              <div className="review-row">
                <strong>
                  <Clipped value={b.name} max={80} />
                </strong>{' '}
                <span className="history-tag">{text(b.change).slice(0, 20)}</span>
                <div className="history-meta">
                  Volume {shownNumber(num(base.volume))} to {shownNumber(num(head.volume))} mm³ (
                  {signed(num(delta.volume))}); area {shownNumber(num(base.area))} to{' '}
                  {shownNumber(num(head.area))} mm² ({signed(num(delta.area))})
                  {num(head.mass) !== null && `; mass ${shownNumber(num(head.mass))} g`}
                </div>
                {text(b.error) && (
                  <div className="history-error">
                    <Clipped value={b.error} max={200} />
                  </div>
                )}
              </div>
            );
          }}
        />
      )}
      {interference.length > 0 && (
        <>
          <h5>Interference at the stored poses</h5>
          <Paged
            items={interference}
            render={(a) => (
              <div className="review-row">
                <Clipped value={a.name} max={80} />: {list(a.base).length} overlapping pairs at
                base, {list(a.head).length} at head
                {text(a.error) && (
                  <>
                    {' '}
                    (<Clipped value={a.error} max={200} />)
                  </>
                )}
              </div>
            )}
          />
        </>
      )}
    </>
  );
}

function Issue({ issue }: { issue: Record<string, unknown> }) {
  return (
    <div className="review-row">
      <span className={issue.severity === 'error' ? 'history-error' : 'history-tag'}>
        {issue.severity === 'error' ? 'Error' : 'Warning'}
      </span>{' '}
      <Clipped value={issue.message} max={200} />
      <div className="history-meta">
        {text(issue.where).slice(0, 20)} {text(issue.featureId || issue.id).slice(0, 80)}, code{' '}
        {text(issue.code).slice(0, 80)}
      </div>
    </div>
  );
}

function RegenErrors({ bundle }: { bundle: ReviewBundle }) {
  const regen = obj(bundle.regen);
  const counts = obj(regen.counts);
  const side = (x: unknown) => {
    const c = obj(x);
    return `${count(c.errors)} errors, ${count(c.warnings)} warnings`;
  };
  const section = (key: 'new' | 'remaining' | 'resolved', title: string) => {
    const l = obj(regen[key]);
    const items = list(l.items).map(obj);
    if (items.length === 0 && count(l.omitted) === 0) return null;
    return (
      <>
        <h5>
          {title} ({items.length + count(l.omitted)})
        </h5>
        <Paged
          items={items}
          omitted={count(l.omitted)}
          testId={`review-errors-${key}`}
          render={(issue) => <Issue issue={issue} />}
        />
      </>
    );
  };
  return (
    <>
      <p className="history-meta" data-testid="review-error-counts">
        Base: {side(counts.base)}. Head: {side(counts.head)}.
      </p>
      {section('new', 'New at head')}
      {section('remaining', 'At base and head')}
      {section('resolved', 'Resolved')}
    </>
  );
}

function QuantityDeltas({ bundle }: { bundle: ReviewBundle }) {
  const q = obj(bundle.quantities);
  const rows = obj(q.rows);
  const items = list(rows.items).map(obj);
  const totals = list(q.totals).map(obj);
  const notes = list(q.notes);
  if (items.length === 0 && totals.length === 0 && notes.length === 0) {
    return <p className="field-note">No quantity changed.</p>;
  }
  const side = (x: unknown) => {
    const s = obj(x);
    return x === null || x === undefined ? 'none' : shownNumber(num(s.quantity));
  };
  return (
    <>
      <Paged
        items={items}
        omitted={count(rows.omitted)}
        testId="review-quantities"
        render={(r) => (
          <div className="review-row">
            <Clipped value={r.list} max={80} />: <Clipped value={r.item} max={120} />,{' '}
            {side(r.base)} to {side(r.head)} <Clipped value={r.unit} max={20} />
          </div>
        )}
      />
      {totals.length > 0 && (
        <Paged
          items={totals}
          render={(t) => (
            <div className="review-row">
              Total <Clipped value={t.list} max={80} />, <Clipped value={t.group} max={80} />:{' '}
              {shownNumber(num(t.base))} to {shownNumber(num(t.head))}{' '}
              <Clipped value={t.unit} max={20} />
            </div>
          )}
        />
      )}
      {notes.length > 0 && <Paged items={notes} render={(n) => <Clipped value={n} max={300} />} />}
    </>
  );
}

function Fields({ fields }: { fields: unknown }) {
  const items = list(fields).map(obj);
  if (items.length === 0) return null;
  return (
    <Paged
      items={items}
      className="review-list review-fields"
      render={(f) => (
        <span>
          <code>
            <Clipped value={f.path} max={80} />
          </code>
          : <Clipped value={f.before} max={120} /> to <Clipped value={f.after} max={120} />
        </span>
      )}
    />
  );
}

function Containers({ title, items }: { title: string; items: unknown }) {
  const containers = list(items).map(obj);
  if (containers.length === 0) return null;
  return (
    <>
      {containers.slice(0, 200).map((c, i) => {
        const inner = obj(c.items);
        return (
          <div key={i} className="review-container" data-testid="review-container">
            <h5>
              {title} <Clipped value={c.name} max={80} />{' '}
              <span className="history-tag">{text(c.change).slice(0, 20)}</span>
            </h5>
            <Fields fields={c.fields} />
            <Paged
              items={list(inner.items).map(obj)}
              omitted={count(inner.omitted)}
              testId="review-items"
              render={(item) => (
                <div className="review-row">
                  <Clipped value={item.summary} max={200} />
                  <Fields fields={item.fields} />
                </div>
              )}
            />
          </div>
        );
      })}
      {containers.length > 200 && <p className="field-note">and {containers.length - 200} more</p>}
    </>
  );
}

function Scripts({ scripts }: { scripts: readonly ShownScript[] }) {
  if (scripts.length === 0) return <p className="field-note">The branch has no scripts.</p>;
  return (
    <Paged
      items={scripts}
      testId="review-scripts"
      render={(s) => (
        <div className="review-row" data-testid="review-script">
          <strong>
            <Clipped value={s.name} max={80} />
          </strong>{' '}
          <span className="history-tag">
            {s.change === 'unlisted' ? 'not listed in the bundle' : s.change}
          </span>
          {s.differs && (
            <p className="history-error" role="alert">
              The bundle shows this script otherwise: what is shown here is the branch head&apos;s.
            </p>
          )}
          {s.hiddenCharacters && (
            <p className="history-error" role="alert" data-testid="review-script-hidden">
              This script holds hidden characters (bidirectional overrides or zero-width marks),
              shown below as escapes such as \u{'{202e}'}: what you read may not be what runs.
            </p>
          )}
          <Clipped value={s.source} max={2000} pre />
          {s.previous !== null && (
            <details>
              <summary>Before</summary>
              <Clipped value={s.previous} max={2000} pre />
            </details>
          )}
        </div>
      )}
    />
  );
}

function Command({ c }: { c: Record<string, unknown> }) {
  const [json, setJson] = useState(false);
  return (
    <div className="review-row">
      <Clipped value={c.summary} max={200} />{' '}
      <button
        type="button"
        className="review-link"
        aria-expanded={json}
        data-testid="review-command-json"
        onClick={() => setJson((x) => !x)}
      >
        {json ? 'Hide JSON' : 'JSON'}
      </button>
      {json && (
        <>
          <Clipped value={c.json} max={4000} pre />
          {c.truncated === true && <p className="field-note">Cut short in the bundle.</p>}
        </>
      )}
    </div>
  );
}

function Commands({ bundle }: { bundle: ReviewBundle }) {
  const commands = obj(bundle.commands);
  const batches = obj(commands.batches);
  const items = list(batches.items).map(obj);
  if (items.length === 0) return <p className="field-note">No commands.</p>;
  return (
    <>
      <Paged
        items={items}
        omitted={count(batches.omitted)}
        testId="review-batches"
        render={(b) => (
          <div className="review-batch">
            <div className="history-item-head">
              <span className="history-name">
                <Clipped value={b.label} max={120} />
              </span>
              <span className="history-meta">
                revision {shownNumber(num(b.revision))}
                {b.cause === 'undo' ? ', undo' : ''}
              </span>
            </div>
            <Paged items={list(b.commands).map(obj)} render={(c) => <Command c={c} />} />
          </div>
        )}
      />
      {count(commands.omittedCommands) > 0 && (
        <p className="field-note">and {count(commands.omittedCommands)} more commands</p>
      )}
    </>
  );
}

function Domains({ bundle }: { bundle: ReviewBundle }) {
  const domains = list(bundle.domains).map(obj);
  if (domains.length === 0) return null;
  return (
    <Paged
      items={domains}
      render={(d) => (
        <div className="review-row">
          <strong>
            <Clipped value={d.namespace} max={80} />
          </strong>{' '}
          <span className="history-tag">{text(d.change).slice(0, 20)}</span>
          <Paged
            items={list(d.lines)}
            omitted={count(d.omitted)}
            render={(l) => <Clipped value={l} max={300} />}
          />
        </div>
      )}
    />
  );
}

/** Every section of `bundle`, each guarded. */
export function BundleView({
  bundle,
  scripts,
  read,
}: {
  bundle: ReviewBundle;
  /** The branch head's scripts (`branchScripts`): shown instead of the bundle's. */
  scripts: readonly ShownScript[];
  read: Read;
}) {
  const features = obj(bundle.features);
  const hasFeatures =
    list(features.parts).length + list(features.assemblies).length + list(bundle.document).length >
      0 || list(bundle.domains).length > 0;
  return (
    <div className="review-bundle" data-testid="review-bundle">
      <section>
        <h4>Renders</h4>
        <Guarded what="The renders">
          <Renders bundle={bundle} read={read} />
        </Guarded>
      </section>
      <section>
        <h4>Measurements</h4>
        <Guarded what="The measurements">
          <Measurements bundle={bundle} />
        </Guarded>
      </section>
      <section>
        <h4>Regen errors</h4>
        <Guarded what="The regen errors">
          <RegenErrors bundle={bundle} />
        </Guarded>
      </section>
      <section>
        <h4>Quantities</h4>
        <Guarded what="The quantities">
          <QuantityDeltas bundle={bundle} />
        </Guarded>
      </section>
      <section>
        <h4>Features</h4>
        <Guarded what="The feature diff">
          {!hasFeatures && <p className="field-note">No feature changed.</p>}
          <Containers title="Part studio" items={features.parts} />
          <Containers title="Assembly" items={features.assemblies} />
          {list(bundle.document).length > 0 && (
            <>
              <h5>Document</h5>
              <Fields fields={bundle.document} />
            </>
          )}
          <Domains bundle={bundle} />
        </Guarded>
      </section>
      <section>
        <h4>Scripts</h4>
        <Guarded what="The scripts">
          <Scripts scripts={scripts} />
        </Guarded>
      </section>
      <section>
        <h4>Commands</h4>
        <Guarded what="The commands">
          <Commands bundle={bundle} />
        </Guarded>
      </section>
    </div>
  );
}
