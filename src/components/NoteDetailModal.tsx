import { useEffect, useMemo, useState } from "react";
import type { NoteItem, ProjectItem } from "../types/api";

type NoteModalMode = "edit" | "create";

type NoteDetailModalProps = {
  open: boolean;
  note: NoteItem | null;
  projects: ProjectItem[];
  busy: boolean;
  mode?: NoteModalMode;
  onClose: () => void;
  onDelete?: () => void;
  onSave: (payload: { noteId?: string; title: string; body: string; convertToTask: boolean; projectId: string | null }) => void;
};

export function NoteDetailModal(props: NoteDetailModalProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");

  const mode = props.mode ?? "edit";
  const isCreateMode = mode === "create";

  useEffect(() => {
    if (!props.open) return;
    if (isCreateMode) {
      setTitle("");
      setBody("");
      setProjectId("");
      return;
    }
    if (!props.note) return;
    setTitle(props.note.title ?? "");
    setBody(props.note.body ?? "");
    setProjectId(props.note.project_id ?? "");
  }, [props.open, props.note?.id, props.note, isCreateMode]);

  const isDirty = useMemo(() => {
    if (isCreateMode) {
      return Boolean(title.trim() || body.trim() || projectId);
    }
    if (!props.note) return false;
    return !(
      title.trim() === (props.note.title ?? "") &&
      body.trim() === (props.note.body ?? "") &&
      (projectId || null) === props.note.project_id
    );
  }, [title, body, projectId, isCreateMode, props.note]);

  if (!props.open || (!isCreateMode && !props.note)) return null;

  const saveDisabled = props.busy || !body.trim();

  function closeWithGuard() {
    if (!isDirty) {
      props.onClose();
      return;
    }
    const confirmed = window.confirm(
      isCreateMode ? "Є незбережені дані. Закрити без створення нотатки?" : "Є незбережені зміни. Закрити без збереження?"
    );
    if (confirmed) props.onClose();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={closeWithGuard}>
      <section className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>{isCreateMode ? "Створити нотатку" : "Редагування нотатки"}</h3>
          <p className="modal-task-title">
            {isCreateMode ? "Нова нотатка" : `Оновлено: ${new Date(props.note!.updated_at).toLocaleString()}`}
          </p>
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
            Проєкт
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={props.busy}>
              <option value="">Без проєкту</option>
              {props.projects.length === 0 ? (
                <option value="" disabled>
                  Немає проєктів
                </option>
              ) : null}
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
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
          {!isCreateMode ? (
            <p className="inbox-meta">
              Нотатка не має дедлайну чи часу. «Перетворити в задачу» створює задачу і прибирає нотатку зі списку.
            </p>
          ) : null}
        </div>

        <footer className="modal-footer">
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={closeWithGuard} disabled={props.busy}>
              {isCreateMode ? "Скасувати" : "Закрити"}
            </button>
            <button
              type="button"
              onClick={() =>
                props.onSave({
                  noteId: props.note?.id,
                  title: title.trim(),
                  body: body.trim(),
                  convertToTask: false,
                  projectId: projectId || null
                })
              }
              disabled={saveDisabled}
            >
              {props.busy ? (isCreateMode ? "Створення..." : "Збереження...") : isCreateMode ? "Створити" : "Зберегти"}
            </button>
            {!isCreateMode ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    props.onSave({
                      noteId: props.note?.id,
                      title: title.trim(),
                      body: body.trim(),
                      convertToTask: true,
                      projectId: projectId || null
                    })
                  }
                  disabled={saveDisabled}
                >
                  Перетворити в задачу
                </button>
                {props.onDelete ? (
                  <button type="button" className="danger" onClick={props.onDelete} disabled={props.busy}>
                    Видалити
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}
