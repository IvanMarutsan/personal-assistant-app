import { useEffect, useState } from "react";
import type { NoteItem } from "../types/api";

type NoteDetailModalProps = {
  open: boolean;
  note: NoteItem | null;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: { title: string; body: string; convertToTask: boolean }) => void;
};

export function NoteDetailModal(props: NoteDetailModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!props.open || !props.note) return;
    setTitle(props.note.title ?? "");
    setBody(props.note.body ?? "");
  }, [props.open, props.note?.id]);

  if (!props.open || !props.note) return null;

  const saveDisabled = props.busy || !body.trim();

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={props.onClose}>
      <section className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>Редагування нотатки</h3>
          <p className="modal-task-title">Оновлено: {new Date(props.note.updated_at).toLocaleString()}</p>
        </header>

        <div className="modal-body">
          <label>
            Назва
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Назва нотатки (необов'язково)"
              disabled={props.busy}
            />
          </label>
          <label>
            Текст нотатки
            <textarea
              rows={10}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Текст нотатки"
              disabled={props.busy}
            />
          </label>
          <p className="inbox-meta">
            Нотатка не має дедлайну/часу. «Перетворити в задачу» створює задачу і прибирає нотатку зі списку.
          </p>
        </div>

        <footer className="modal-footer">
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={props.onClose} disabled={props.busy}>
              Закрити
            </button>
            <button
              type="button"
              onClick={() => props.onSave({ title: title.trim(), body: body.trim(), convertToTask: false })}
              disabled={saveDisabled}
            >
              {props.busy ? "Збереження..." : "Зберегти"}
            </button>
            <button
              type="button"
              onClick={() => props.onSave({ title: title.trim(), body: body.trim(), convertToTask: true })}
              disabled={saveDisabled}
            >
              Перетворити в задачу
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
