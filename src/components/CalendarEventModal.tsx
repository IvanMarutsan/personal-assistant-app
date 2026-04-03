import { useEffect, useMemo, useRef, useState } from "react";

type CalendarEventModalProps = {
  open: boolean;
  titleHint: string;
  detailsHint?: string | null;
  startHint?: string | null;
  endHint?: string | null;
  busy: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: (payload: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setTitle(props.titleHint || "");
    setDescription(props.detailsHint ?? "");
    setStartAtInput(toLocalInput(props.startHint));
    setEndAtInput(toLocalInput(props.endHint));
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setError(null);
  }, [props.open, props.titleHint, props.detailsHint, props.startHint, props.endHint]);

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

  const submitDisabled = useMemo(() => props.busy || !title.trim() || !startAtInput.trim(), [props.busy, title, startAtInput]);

  if (!props.open) return null;

  function submit() {
    setError(null);
    const startAt = toIso(startAtInput);
    const endAt = toIso(endAtInput);
    if (!startAt) {
      setError("Вкажи коректний час початку.");
      return;
    }
    if (endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      setError("Час завершення має бути пізніше за початок.");
      return;
    }

    props.onConfirm({
      title: title.trim(),
      description: description.trim(),
      startAt,
      endAt,
      timezone: timezone.trim() || "UTC"
    });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card">
        <header className="modal-header">
          <h3>Створити подію в Google Calendar</h3>
          <p className="modal-task-title">Явна дія: подія створюється лише після підтвердження</p>
        </header>

        <div className="modal-body" ref={bodyRef}>
          <label>
            Назва
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Опис
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
          </label>
          <label>
            Початок
            <input type="datetime-local" value={startAtInput} onChange={(event) => setStartAtInput(event.target.value)} />
          </label>
          <label>
            Завершення (необов'язково)
            <input type="datetime-local" value={endAtInput} onChange={(event) => setEndAtInput(event.target.value)} />
          </label>
          <label>
            Таймзона
            <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          {props.errorMessage ? <p className="error-note">{props.errorMessage}</p> : null}
          {error ? <p className="error-note">{error}</p> : null}
        </div>

        <footer className="modal-footer">
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={props.onCancel} disabled={props.busy}>
              Скасувати
            </button>
            <button type="button" onClick={submit} disabled={submitDisabled}>
              {props.busy ? "Створення..." : "Створити подію"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
