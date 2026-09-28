import { useState } from "react";
import { Sheet } from "../../components/layout/Sheet";
import { Button, InlineError } from "../../components/ui";
import type { PromptLibraryImportMode } from "../../domain/types";
import { apiMessage } from "../../lib/errors";

// Offered when the file's library name is already taken. Unlike
// ConfirmDialog it has three ways forward, each posting the same file with a
// different `onConflict`; a failure (such as ambiguous prompt names) shows
// here so the user can pick another mode without reopening the file.
export function ImportConflictDialog({
  name,
  onCancel,
  onChoose,
}: {
  name: string;
  onCancel: () => void;
  onChoose: (mode: PromptLibraryImportMode) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<PromptLibraryImportMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (mode: PromptLibraryImportMode) => {
    setSubmitting(mode);
    setError(null);
    try {
      await onChoose(mode);
    } catch (cause) {
      setError(apiMessage(cause));
    } finally {
      setSubmitting(null);
    }
  };

  const busy = submitting !== null;

  return (
    <Sheet onCancel={busy ? () => undefined : onCancel} title={`“${name}” already exists`}>
      <div className="confirm-dialog">
        <div className="confirm-dialog__message">
          <p>A library named “{name}” is already here. Choose how to import the file:</p>
          <ul className="import-conflict__options">
            <li>
              <strong>Append</strong> adds the prompts and categories that are
              missing and leaves everything else untouched.
            </li>
            <li>
              <strong>Append and replace</strong> also overwrites prompts with the
              same name: body, note, and categories come from the file; order and
              usage stay.
            </li>
            <li>
              <strong>Import as copy</strong> creates a separate library named
              “{name} (2)”, or the next free number.
            </li>
          </ul>
        </div>
        <InlineError message={error} />
        <div className="form-actions import-conflict__actions">
          <Button disabled={busy} onClick={onCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <span className="import-conflict__spacer" />
          <Button
            disabled={busy}
            onClick={() => void choose("append")}
            type="button"
            variant="outline"
          >
            {submitting === "append" ? "Appending" : "Append"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void choose("replace")}
            type="button"
            variant="outline"
          >
            {submitting === "replace" ? "Replacing" : "Append and replace"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void choose("copy")}
            type="button"
            variant="primary"
          >
            {submitting === "copy" ? "Copying" : "Import as copy"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
