import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectItem } from "../types/api";

type CalendarEventModalProps = {
  open: boolean;
  titleHint: string;
  detailsHint?: string | null;
  startHint?: string | null;
  endHint?: string | null;
  busy: boolean;
  errorMessage?: string | null;
  heading?: string;
  subtitle?: string;
  confirmLabel?: string;
  deleteLabel?: string;
  projectIdHint?: string | null;
  projectOptions?: ProjectItem[];
  readOnlyReason?: string | null;
  onCancel: () => void;
  onDelete?: () => void;
  onConfirm: (payload: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    projectId: string | null;
  }) => void;
};

function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  const localDate = new Date(parsed.getTime() - offsetMs);
  return localDate.toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function CalendarEventModal(props: CalendarEventModalProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startAtInput, setStartAtInput] = useState("");
  const [endAtInput, setEndAtInput] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setTitle(props.titleHint || "");
    setDescription(props.detailsHint ?? "");
    setStartAtInput(toLocalInput(props.startHint));
    setEndAtInput(toLocalInput(props.endHint));
    setProjectId(props.projectIdHint ?? "");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setError(null);
  }, [props.open, props.titleHint, props.detailsHint, props.startHint, props.endHint, props.projectIdHint]);

  useEffect(() => {
    if (!props.open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    });
  }, [props.open, props.titleHint]);

  const submitDisabled = useMemo(
    () => props.busy || !title.trim() || !startAtInput.trim() || Boolean(props.readOnlyReason),
    [props.busy, title, startAtInput, props.readOnlyReason]
  );

  if (!props.open) return null;

  function submit() {
    if (props.readOnlyReason) return;
    setError(null);
    const startAt = toIso(startAtInput);
    const endAt = toIso(endAtInput);
    if (!startAt) {
      setError("Потрібно вказати час початку.");
      return;
    }
    if (!endAt) {
      setError("Потрібно вказати час завершення.");
      return;
    }
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      setError("Час завершення має бути пізніше за початок.");
      return;
    }

    props.onConfirm({
      title: title.trim(),
      description: description.trim(),
      startAt,
      endAt,
      timezone: timezone.trim() || "UTC",
      projectId: projectId || null
    });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card">
        <header className="modal-header">
          <h3>{props.heading ?? "Подія в Google Calendar"}</h3>
          <p className="modal-task-title">{props.subtitle ?? "Тут можна спокійно оновити часовий блок або подію."}</p>
        </header>

        <div className="modal-body" ref={bodyRef}>
          <label>
            Назва
            <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={props.busy || Boolean(props.readOnlyReason)} />
          </label>
          <label>
            Короткий опис
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} disabled={props.busy || Boolean(props.readOnlyReason)} />
          </label>
          {props.projectOptions ? (
            <label>
              Проєкт
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={props.busy || Boolean(props.readOnlyReason)}>
                <option value="">Без проєкту</option>
                {props.projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Початок блоку
            <input type="datetime-local" value={startAtInput} onChange={(event) => setStartAtInput(event.target.value)} disabled={props.busy || Boolean(props.readOnlyReason)} />
          </label>
          <label>
            Завершення блоку
            <input type="datetime-local" value={endAtInput} onChange={(event) => setEndAtInput(event.target.value)} disabled={props.busy || Boolean(props.readOnlyReason)} />
          </label>
          <label>
            Таймзона
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} disabled={props.busy || Boolean(props.readOnlyReason)} />
          </label>
          {props.readOnlyReason ? <p className="modal-readonly-note">{props.readOnlyReason}</p> : null}
          {props.errorMessage ? <p className="error-note">{props.errorMessage}</p> : null}
          {error ? <p className="error-note">{error}</p> : null}
        </div>

        <footer className="modal-footer">
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={props.onCancel} disabled={props.busy}>
              Скасувати
            </button>
            {props.onDelete ? (
              <button type="button" className="danger" onClick={props.onDelete} disabled={props.busy}>
                {props.deleteLabel ?? "Видалити"}
              </button>
            ) : null}
            <button type="button" onClick={submit} disabled={submitDisabled}>
              {props.busy ? "Збереження..." : props.confirmLabel ?? "Зберегти подію"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

