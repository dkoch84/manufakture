// The assembly's tree (M2 plan, T2.3e), where a part studio shows its feature tree: the
// assembly's degrees of freedom (or why they cannot be counted), its instances (fix and unfix,
// suppress, delete) and its mates, each with what the last solve said of it: ok, redundant,
// conflicting (with the explanation, and the mate to blame marked), an error regen found (a
// connector to re-pick), or suppressed. An instance whose source has a configuration table can be
// built in any of its rows (T2.4c). Every change is one undoable command.

import type { Command } from '@manufakture/core';
import type { AssemblyResult } from '@manufakture/regen';
import { useState } from 'react';
import { useStore } from 'zustand';
import { ConfigurationPicker } from '../features/ConfigurationPicker';
import type { DocumentStoreApi } from '../state/document';
import {
  MATE_KIND_LABELS,
  assemblySummary,
  instanceBlockers,
  instanceRowCommand,
  instanceRows,
  mateRows,
  sourceLabel,
  type MateRowStatus,
} from './assembly';

export interface AssemblyTreeProps {
  documents: DocumentStoreApi;
  assemblyId: string;
  /** The last regen's result for the assembly; undefined until there is one. */
  result: AssemblyResult | undefined;
  /** Nothing can be changed (a dialog is open, or a past version is shown). */
  disabled?: boolean;
  onEditMate: (mateId: string) => void;
}

const STATUS_TEXT: Record<MateRowStatus, string> = {
  ok: 'OK',
  redundant: 'Redundant',
  conflicting: 'Conflicting',
  invalid: 'Invalid',
  suppressed: 'Suppressed',
  error: 'Error',
  pending: 'Solving',
};

export function AssemblyTree({
  documents,
  assemblyId,
  result,
  disabled = false,
  onEditMate,
}: AssemblyTreeProps) {
  const doc = useStore(documents, (s) => s.document);
  const [message, setMessage] = useState<string | null>(null);
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  if (!assembly) return null;
  const run = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
  };
  const rows = mateRows(assembly, result);
  const blockers = instanceBlockers(assembly);
  const stale = result !== undefined && rows.some((r) => r.status === 'pending');

  return (
    <aside className="feature-tree assembly-tree" aria-label="Assembly" data-testid="assembly-tree">
      <h2>{assembly.name}</h2>
      <p
        className={
          result?.outcome === 'conflicting' ? 'assembly-summary conflict' : 'assembly-summary'
        }
        role="status"
        data-testid="assembly-dof"
        data-dof={result?.dof ?? ''}
      >
        {stale ? 'Solving...' : assemblySummary(result)}
      </p>
      <h3>Instances</h3>
      {assembly.instances.length === 0 ? (
        <p className="field-note" data-testid="assembly-empty">
          Nothing here yet. <strong>Insert</strong> a part studio of this document, or a part of
          another document at a version.
        </p>
      ) : (
        <ul className="assembly-list">
          {assembly.instances.map((inst) => {
            const r = result?.instances.find((x) => x.instanceId === inst.id);
            const problem = r?.errors[0]?.message ?? r?.warnings[0]?.message ?? null;
            const usedBy = blockers.get(inst.id) ?? [];
            const rowChoice = instanceRows(doc, inst.source);
            return (
              <li
                key={inst.id}
                className={inst.suppressed ? 'suppressed' : r?.status === 'error' ? 'error' : ''}
                data-testid={`instance-${inst.id}`}
              >
                <span className="assembly-item-name" title={sourceLabel(doc, inst.source)}>
                  {inst.name}
                  {inst.fixed && <span className="assembly-badge"> fixed</span>}
                </span>
                <span className="assembly-item-source">{sourceLabel(doc, inst.source)}</span>
                {problem && (
                  <span className="assembly-item-message" role="note">
                    {problem}
                  </span>
                )}
                {rowChoice && (
                  <ConfigurationPicker
                    rows={rowChoice.rows}
                    value={rowChoice.value}
                    defaultLabel={rowChoice.defaultLabel}
                    testId={`instance-configuration-${inst.id}`}
                    disabled={disabled}
                    onChange={(row) => {
                      const { command, label } = instanceRowCommand(assemblyId, inst, row, doc);
                      run(command, label);
                    }}
                  />
                )}
                <span className="assembly-item-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={inst.fixed}
                    data-testid={`instance-fix-${inst.id}`}
                    title={inst.fixed ? 'Let it move with its mates' : 'Keep it where it is'}
                    onClick={() =>
                      run(
                        {
                          type: 'editInstance',
                          assemblyId,
                          instanceId: inst.id,
                          fixed: !inst.fixed,
                        },
                        `${inst.fixed ? 'Unfix' : 'Fix'} ${inst.name}`,
                      )
                    }
                  >
                    {inst.fixed ? 'Unfix' : 'Fix'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={inst.suppressed}
                    data-testid={`instance-suppress-${inst.id}`}
                    onClick={() =>
                      run(
                        {
                          type: 'editInstance',
                          assemblyId,
                          instanceId: inst.id,
                          suppressed: !inst.suppressed,
                        },
                        `${inst.suppressed ? 'Unsuppress' : 'Suppress'} ${inst.name}`,
                      )
                    }
                  >
                    {inst.suppressed ? 'Unsuppress' : 'Suppress'}
                  </button>
                  <button
                    type="button"
                    disabled={disabled || usedBy.length > 0}
                    data-testid={`instance-delete-${inst.id}`}
                    title={
                      usedBy.length > 0
                        ? `Mated by ${usedBy.join(', ')}: delete those mates first`
                        : undefined
                    }
                    onClick={() =>
                      run(
                        { type: 'deleteInstance', assemblyId, instanceId: inst.id },
                        `Delete ${inst.name}`,
                      )
                    }
                  >
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <h3>Mates</h3>
      {rows.length === 0 ? (
        <p className="field-note">
          No mates yet: <strong>Mate</strong> two instances by a face, edge or vertex of each.
        </p>
      ) : (
        <ul className="assembly-list" data-testid="mates-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`mate-row status-${row.status}${row.blamed ? ' blamed' : ''}`}
              data-testid={`mate-${row.id}`}
            >
              <span className="assembly-item-name">
                {row.name}
                <span className="assembly-badge"> {MATE_KIND_LABELS[row.kind]}</span>
              </span>
              <span className="mate-status" data-testid={`mate-status-${row.id}`}>
                {STATUS_TEXT[row.status]}
                {row.blamed ? ': change or suppress this one' : ''}
              </span>
              {row.message && (
                <span className="assembly-item-message" role="note">
                  {row.message}
                </span>
              )}
              <span className="assembly-item-actions">
                <button
                  type="button"
                  disabled={disabled}
                  data-testid={`mate-edit-${row.id}`}
                  onClick={() => onEditMate(row.id)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={row.suppressed}
                  data-testid={`mate-suppress-${row.id}`}
                  onClick={() =>
                    run(
                      {
                        type: 'suppressMate',
                        assemblyId,
                        mateId: row.id,
                        suppressed: !row.suppressed,
                      },
                      `${row.suppressed ? 'Unsuppress' : 'Suppress'} ${row.name}`,
                    )
                  }
                >
                  {row.suppressed ? 'Unsuppress' : 'Suppress'}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  data-testid={`mate-delete-${row.id}`}
                  onClick={() =>
                    run({ type: 'deleteMate', assemblyId, mateId: row.id }, `Delete ${row.name}`)
                  }
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="field-error" role="alert" data-testid="assembly-error">
          {message}
        </p>
      )}
    </aside>
  );
}
