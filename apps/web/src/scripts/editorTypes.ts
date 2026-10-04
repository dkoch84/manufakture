// What the script editor's code area takes: kept apart from CodeEditor.tsx so the editor panel
// (and its tests, which use a plain text area) can name it without loading CodeMirror.

import type { ComponentType } from 'react';

/** An error to mark in the source: 1-based line and column, as regen reports them. */
export interface EditorMarker {
  line?: number;
  column?: number;
  message: string;
  /** Where it comes from ("Scripted 1"), shown with the message. */
  source?: string;
}

export interface CodeEditorProps {
  value: string;
  language: 'js' | 'ts';
  markers: readonly EditorMarker[];
  /** The accessible name of the code area. */
  label: string;
  onChange: (value: string) => void;
}

export type CodeEditorComponent = ComponentType<CodeEditorProps>;
