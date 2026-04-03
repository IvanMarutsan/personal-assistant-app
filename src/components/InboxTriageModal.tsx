import { useEffect, useState } from "react";

type InboxTriageModalProps = {
  open: boolean;
  mode: "task" | "note" | null;
  sourceText: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (payload: { title?: string; noteBody?: string }) => void;
};

export function InboxTriageModal(props: InboxTriageModalProps) {
  const [title, setTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  useEffect(() => {
    if (!props.open) return;
    setTitle(props.sourceText.slice(0, 120));
    setNoteBody(props.sourceText);
  }, [props.open, props.sourceText]);

  if (!props.open || !props.mode) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{props.mode === "task" ? "Перетворення в задачу" : "Перетворення в нотатку"}</h3>

        {props.mode === "task" ? (
          <label>
            Назва задачі
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          </label>
        ) : null}

        {props.mode === "note" ? (
          <label>
            Текст нотатки
            <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} rows={5} />
          </label>
        ) : null}

        <div className="modal-actions">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            Скасувати
          </button>
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                title: title.trim() || undefined,
                noteBody: noteBody.trim() || undefined
              })
            }
            disabled={props.busy}
          >
            Підтвердити
          </button>
        </div>
      </div>
    </div>
  );
}
