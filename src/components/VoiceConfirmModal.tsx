import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectItem, TaskType, VoiceAiSuggestion, VoiceConfirmTargetKind } from "../types/api";

type VoiceConfirmModalProps = {
  open: boolean;
  contextId?: string | null;
  defaultKind: VoiceConfirmTargetKind;
  allowCalendarEvent?: boolean;
  suggestion: VoiceAiSuggestion | null;
  transcript: string;
  projectMatch?: {
    matchedProjectId: string | null;
    matchedProjectName: string | null;
    status: "matched" | "suggested_only" | "none";
    score: number | null;
  } | null;
  projects: ProjectItem[];
  busy: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onConfirm: (payload: {
    targetKind: VoiceConfirmTargetKind;
    title: string;
    details: string;
    noteBody: string;
    projectId: string | null;
    taskType: TaskType | null;
    importance: number | null;
    dueAt: string | null;
    scheduledFor: string | null;
    timezone: string;
  }) => void;
};

const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "deep_work", label: "Глибока робота" },
  { value: "quick_communication", label: "Швидка комунікація" },
  { value: "admin_operational", label: "Операційне" },
  { value: "recurring_essential", label: "Регулярне важливе" },
  { value: "personal_essential", label: "Особисто важливе" },
  { value: "someday", label: "Колись" }
];

function toLocalInputFromDate(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60_000;
  const localDate = new Date(value.getTime() - offsetMs);
  return localDate.toISOString().slice(0, 16);
}

function parseReasonableDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const currentYear = new Date().getFullYear();
  if (year < currentYear - 1 || year > currentYear + 5) return null;
  return date;
}

function extractTime(hint: string): { hours: number; minutes: number } | null {
  const match = hint.match(/(\d{1,2})[:.](\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function nextWeekdayIndex(now: Date, targetWeekday: number): Date {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const current = base.getDay();
  let diff = (targetWeekday - current + 7) % 7;
  if (diff === 0) diff = 7;
  base.setDate(base.getDate() + diff);
  return base;
}

function parseNaturalDateHint(hint: string | null | undefined): Date | null {
  if (!hint) return null;
  const text = hint.trim().toLowerCase();
  if (!text) return null;
  const now = new Date();
  const time = extractTime(text) ?? { hours: 9, minutes: 0 };

  const setTime = (d: Date): Date => {
    const out = new Date(d);
    out.setHours(time.hours, time.minutes, 0, 0);
    return out;
  };

  if (text.includes("today") || text.includes("сьогодні")) {
    return setTime(now);
  }
  if (text.includes("tomorrow") || text.includes("завтра")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return setTime(d);
  }

  const weekdays: Array<{ keys: string[]; index: number }> = [
    { keys: ["sunday", "неділя", "недiля", "недiлю", "неділю"], index: 0 },
    { keys: ["monday", "понеділок", "понедiлок"], index: 1 },
    { keys: ["tuesday", "вівторок", "вiвторок"], index: 2 },
    { keys: ["wednesday", "середа"], index: 3 },
    { keys: ["thursday", "четвер"], index: 4 },
    { keys: ["friday", "пʼятниця", "п'ятниця", "пятниця"], index: 5 },
    { keys: ["saturday", "субота"], index: 6 }
  ];

  for (const weekday of weekdays) {
    if (weekday.keys.some((key) => text.includes(key))) {
      return setTime(nextWeekdayIndex(now, weekday.index));
    }
  }

  return null;
}

function localInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function buildNoteBody(title: string, details: string, dueAt: string, scheduledFor: string): string {
  const cleanTitle = title.trim();
  const cleanDetails = details.trim();
  const lines: string[] = [];
  if (cleanTitle) lines.push(cleanTitle);
  if (cleanDetails) {
    if (lines.length > 0) lines.push("");
    lines.push(cleanDetails);
  }
  if (dueAt || scheduledFor) {
    if (lines.length > 0) lines.push("");
    lines.push("Часові підказки:");
    if (scheduledFor) lines.push(`- Заплановано на: ${scheduledFor}`);
    if (dueAt) lines.push(`- Дедлайн: ${dueAt}`);
  }
  return lines.join("\n").trim();
}

export function VoiceConfirmModal(props: VoiceConfirmModalProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [targetKind, setTargetKind] = useState<VoiceConfirmTargetKind>("task");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [taskType, setTaskType] = useState<TaskType | "">("");
  const [importance, setImportance] = useState<number | "">("");
  const [dueAtInput, setDueAtInput] = useState("");
  const [scheduledForInput, setScheduledForInput] = useState("");
  const [timezone, setTimezone] = useState("UTC");

  useEffect(() => {
    if (!props.open || !props.suggestion) return;
    const normalizedDefaultKind: VoiceConfirmTargetKind =
      props.defaultKind === "calendar_event" && !props.allowCalendarEvent ? "task" : props.defaultKind;
    const scheduledCandidate =
      parseReasonableDate(props.suggestion.scheduledForIso) ??
      parseNaturalDateHint(props.suggestion.datetimeHint) ??
      parseReasonableDate(props.suggestion.datetimeHint);
    const dueCandidate =
      parseReasonableDate(props.suggestion.dueAtIso) ??
      parseNaturalDateHint(props.suggestion.dueHint) ??
      parseReasonableDate(props.suggestion.dueHint);

    setTargetKind(normalizedDefaultKind);
    setTitle(props.suggestion.title ?? "");
    setDetails(props.suggestion.details || props.transcript || "");
    setProjectId(props.projectMatch?.matchedProjectId ?? "");
    setTaskType(props.suggestion.taskTypeGuess ?? "");
    setImportance(props.suggestion.importanceGuess ?? "");
    setDueAtInput(dueCandidate ? toLocalInputFromDate(dueCandidate) : "");
    setScheduledForInput(scheduledCandidate ? toLocalInputFromDate(scheduledCandidate) : "");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    console.debug("[voice-confirm] datetime_mapping", {
      title: props.suggestion.title,
      dueHint: props.suggestion.dueHint,
      datetimeHint: props.suggestion.datetimeHint,
      dueAtIso: props.suggestion.dueAtIso,
      scheduledForIso: props.suggestion.scheduledForIso,
      mappedDueAt: dueCandidate ? dueCandidate.toISOString() : null,
      mappedScheduledFor: scheduledCandidate ? scheduledCandidate.toISOString() : null
    });
  }, [props.open, props.contextId, props.suggestion, props.transcript, props.defaultKind, props.projectMatch, props.allowCalendarEvent]);

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
  }, [props.open, props.contextId, props.defaultKind, props.suggestion?.title]);

  const noteBody = useMemo(
    () => buildNoteBody(title, details, dueAtInput, scheduledForInput),
    [title, details, dueAtInput, scheduledForInput]
  );

  if (!props.open || !props.suggestion) return null;

  const submitDisabled =
    props.busy ||
    (targetKind === "task"
      ? !title.trim()
      : targetKind === "note"
      ? !noteBody.trim()
      : !title.trim() || !scheduledForInput.trim());

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card modal-card--voice">
        <header className="modal-header">
          <h3>Підтвердження голосового розбору</h3>
          <p className="modal-task-title">AI пропонує: відредагуй і підтвердь вручну</p>
          {props.projectMatch?.status === "matched" ? (
            <p className="inbox-meta">
              AI-guess проєкту зіставлено: {props.projectMatch.matchedProjectName ?? "невідомо"}
              {typeof props.projectMatch.score === "number"
                ? ` (${Math.round(props.projectMatch.score * 100)}%)`
                : ""}
            </p>
          ) : null}
          {props.projectMatch?.status === "suggested_only" ? (
            <p className="inbox-meta">AI запропонував проєкт, але точного зіставлення не знайдено.</p>
          ) : null}
          {props.errorMessage ? <p className="error-note">{props.errorMessage}</p> : null}
        </header>

        <div className="modal-body" ref={bodyRef}>
          <label>
            Тип результату
            <select
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as VoiceConfirmTargetKind)}
            >
              <option value="task">Задача</option>
              <option value="note">Нотатка</option>
              {props.allowCalendarEvent ? <option value="calendar_event">Подія Google Calendar</option> : null}
            </select>
          </label>

          <label>
            Назва
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Коротка назва"
              disabled={props.busy}
            />
          </label>

          <label>
            Деталі
            <textarea
              rows={4}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="Що саме потрібно зробити або зберегти"
              disabled={props.busy}
            />
          </label>

          {targetKind === "task" ? (
            <>
              <label>
                Проєкт
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={props.busy}>
                  <option value="">Без проєкту</option>
                  {props.projects.length === 0 ? <option value="" disabled>Немає проєктів</option> : null}
                  {props.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Тип задачі
                <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType | "")}>
                  <option value="">За замовчуванням</option>
                  {TASK_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Важливість (1-5)
                <input
                  type="number"
                  min={1}
                  max={5}
                  step={1}
                  value={importance}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      setImportance("");
                      return;
                    }
                    const parsed = Number(value);
                    if (Number.isNaN(parsed)) {
                      setImportance("");
                      return;
                    }
                    setImportance(Math.max(1, Math.min(5, Math.round(parsed))));
                  }}
                />
              </label>

              <label>
                Заплановано на
                <input
                  type="datetime-local"
                  value={scheduledForInput}
                  onChange={(event) => setScheduledForInput(event.target.value)}
                />
              </label>

              <label>
                Дедлайн
                <input
                  type="datetime-local"
                  value={dueAtInput}
                  onChange={(event) => setDueAtInput(event.target.value)}
                />
              </label>
            </>
          ) : null}
          {targetKind === "calendar_event" ? (
            <>
              <label>
                Початок події
                <input
                  type="datetime-local"
                  value={scheduledForInput}
                  onChange={(event) => setScheduledForInput(event.target.value)}
                />
              </label>
              <label>
                Кінець події (необов'язково)
                <input
                  type="datetime-local"
                  value={dueAtInput}
                  onChange={(event) => setDueAtInput(event.target.value)}
                />
              </label>
              <label>
                Таймзона
                <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
              </label>
            </>
          ) : null}
        </div>

        <footer className="modal-actions modal-footer">
          <button type="button" onClick={props.onCancel} disabled={props.busy}>
            Скасувати
          </button>
          <button
            type="button"
            onClick={() =>
              props.onConfirm({
                targetKind,
                title: title.trim(),
                details: details.trim(),
                noteBody,
                projectId: projectId || null,
                taskType: taskType || null,
                importance: typeof importance === "number" ? importance : null,
                dueAt: localInputToIso(dueAtInput),
                scheduledFor: localInputToIso(scheduledForInput),
                timezone: timezone.trim() || "UTC"
              })
            }
            disabled={submitDisabled}
          >
            {props.busy ? "Збереження..." : "Підтвердити"}
          </button>
        </footer>
      </section>
    </div>
  );
}
