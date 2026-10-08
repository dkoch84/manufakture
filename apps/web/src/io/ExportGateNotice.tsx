// The export gate's refusal as an export dialog or panel shows it (T8.3c): why nothing can be
// exported from the branch that is open, above the controls whose exports it turns off.

export function ExportGateNotice({ refusal }: { refusal: string | null }) {
  if (refusal === null) return null;
  return (
    <p className="field-error" role="alert" data-testid="export-gate-refusal">
      {refusal}
    </p>
  );
}
