import { useEffect, useMemo, useState } from "react";

type InboxTriageModalProps = {
  open: boolean;
  mode: "task" | "note" | null;
  sourceText: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (payload: {
    title?: string;
    noteBody?: string;
    dueAt?: string | null;
    scheduledFor?: string | null;
    estimatedMinutes?: number | null;
  }) => void;
};

function localInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseEstimatedMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function InboxTriageModal(props: InboxTriageModalProps) {
  const [title, setTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [scheduledForInput, setScheduledForInput] = useState("");
  const [dueAtInput, setDueAtInput] = useState("");
  const [estimatedMinutesInput, setEstimatedMinutesInput] = useState("");

  useEffect(() => {
    if (!props.open) return;
    setTitle(props.sourceText.slice(0, 120));
    setNoteBody(props.sourceText);
    setScheduledForInput("");
    setDueAtInput("");
    setEstimatedMinutesInput("");
  }, [props.open, props.sourceText]);

  const parsedEstimatedMinutes = useMemo(() => parseEstimatedMinutes(estimatedMinutesInput), [estimatedMinutesInput]);
  const estimatedMinutesInvalid = estimatedMinutesInput.trim().length > 0 && parsedEstimatedMinutes === null;

  if (!props.open || !props.mode) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>{props.mode === "task" ? "Перетворення в задачу" : "Перетворення в нотатку"}</h3>

        {props.mode === "task" ? (
          <>
            <label>
              Назва задачі
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
            </label>

            <label>
              Планований старт
              <input type="datetime-local" value={scheduledForInput} onChange={(event) => setScheduledForInput(event.target.value)} />
            </label>

            <label>
              Дедлайн
              <input type="datetime-local" value={dueAtInput} onChange={(event) => setDueAtInput(event.target.value)} />
            </label>

            <label>
              Оцінка, хвилин
              <input
                type="number"
                min={1}
                step={1}
                value={estimatedMinutesInput}
                onChange={(event) => setEstimatedMinutesInput(event.target.value)}
                placeholder="Наприклад, 25"
              />
              <p className="inbox-meta">Усі поля необов'язкові. Якщо поспіх, просто підтверди задачу.</p>
              {estimatedMinutesInvalid ? <p className="error-note">Оцінка має бути додатним цілим числом.</p> : null}
            </label>
          </>
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
                noteBody: noteBody.trim() || undefined,
                scheduledFor: localInputToIso(scheduledForInput),
                dueAt: localInputToIso(dueAtInput),
                estimatedMinutes: parsedEstimatedMinutes
              })
            }
            disabled={props.busy || estimatedMinutesInvalid}
          >
            Підтвердити
          </button>
        </div>
      </div>
    </div>
  );
}
