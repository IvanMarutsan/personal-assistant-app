import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { ProjectItem, TaskItem, TaskStatus, TaskType } from "../types/api";
import { moveReasonLabel } from "../lib/reasons";

type TaskActionKind = "done" | "reschedule" | "block" | "unblock" | "cancel";

type TaskDetailModalProps = {
  open: boolean;
  task: TaskItem | null;
  projects: ProjectItem[];
  busy: boolean;
  onClose: () => void;
  onSave: (payload: {
    taskId: string;
    title: string;
    details: string;
    projectId: string | null;
    taskType: TaskType;
    dueAt: string | null;
    scheduledFor: string | null;
    estimatedMinutes: number | null;
  }) => void;
  onAction: (action: TaskActionKind) => void;
  onCreateCalendarEvent: () => void;
  onOpenLinkedCalendarEvent: (url: string) => void;
};

const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "deep_work", label: "Глибока робота" },
  { value: "quick_communication", label: "Швидка комунікація" },
  { value: "admin_operational", label: "Адміністративне" },
  { value: "recurring_essential", label: "Регулярне важливе" },
  { value: "personal_essential", label: "Особисто важливе" },
  { value: "someday", label: "Колись" }
];
const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function statusLabel(status: TaskStatus): string {
  if (status === "planned") return "Заплановано";
  if (status === "in_progress") return "В роботі";
  if (status === "blocked") return "Заблоковано";
  if (status === "done") return "Виконано";
  return "Скасовано";
}

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

function parseEstimatedMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function projectName(task: TaskItem): string {
  if (!task.projects) return "Без проєкту";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "Без проєкту";
  return task.projects.name ?? "Без проєкту";
}

function taskTypeLabel(taskType: TaskType): string {
  return TASK_TYPE_OPTIONS.find((option) => option.value === taskType)?.label ?? taskType;
}

function formatLocalDateTime(value: Date): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: USER_TIMEZONE
  }).format(value);
}

function formatEstimate(value: number | null | undefined): string {
  if (!value) return "Без оцінки";
  return `${value} хв`;
}

function timingLabel(task: TaskItem): string {
  const scheduled = task.scheduled_for ? formatLocalDateTime(new Date(task.scheduled_for)) : null;
  const due = task.due_at ? formatLocalDateTime(new Date(task.due_at)) : null;
  const estimate = formatEstimate(task.estimated_minutes);

  if (!scheduled && !due) return `Беклог · Оцінка: ${estimate}`;
  if (scheduled && due) return `Плановий старт: ${scheduled} · Дедлайн: ${due} · Оцінка: ${estimate}`;
  if (scheduled) return `Плановий старт: ${scheduled} · Оцінка: ${estimate}`;
  return `Беклог · Дедлайн: ${due} · Оцінка: ${estimate}`;
}

export function TaskDetailModal(props: TaskDetailModalProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [projectId, setProjectId] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("admin_operational");
  const [scheduledForInput, setScheduledForInput] = useState("");
  const [dueAtInput, setDueAtInput] = useState("");
  const [estimatedMinutesInput, setEstimatedMinutesInput] = useState("");

  useEffect(() => {
    if (!props.open || !props.task) return;
    setEditMode(false);
    setTitle(props.task.title);
    setDetails(props.task.details ?? "");
    setProjectId(props.task.project_id ?? "");
    setTaskType(props.task.task_type);
    setScheduledForInput(toLocalInput(props.task.scheduled_for));
    setDueAtInput(toLocalInput(props.task.due_at));
    setEstimatedMinutesInput(props.task.estimated_minutes ? String(props.task.estimated_minutes) : "");
  }, [props.open, props.task?.id]);

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
  }, [props.open, props.task?.id, editMode]);

  const parsedEstimatedMinutes = useMemo(() => parseEstimatedMinutes(estimatedMinutesInput), [estimatedMinutesInput]);
  const estimatedMinutesInvalid = estimatedMinutesInput.trim().length > 0 && parsedEstimatedMinutes === null;

  const isDirty = useMemo(() => {
    if (!props.task) return false;
    const sameTitle = title.trim() === props.task.title;
    const sameDetails = details.trim() === (props.task.details ?? "");
    const sameProject = (projectId || null) === props.task.project_id;
    const sameType = taskType === props.task.task_type;
    const sameScheduled = toIso(scheduledForInput) === (props.task.scheduled_for ?? null);
    const sameDue = toIso(dueAtInput) === (props.task.due_at ?? null);
    const sameEstimate = parsedEstimatedMinutes === (props.task.estimated_minutes ?? null);
    return !(sameTitle && sameDetails && sameProject && sameType && sameScheduled && sameDue && sameEstimate);
  }, [props.task, title, details, projectId, taskType, scheduledForInput, dueAtInput, parsedEstimatedMinutes]);

  if (!props.open || !props.task) return null;

  function closeWithGuard() {
    if (!editMode || !isDirty) {
      props.onClose();
      return;
    }
    const confirmed = window.confirm("Є незбережені зміни. Закрити без збереження?");
    if (confirmed) props.onClose();
  }

  function cancelEdit() {
    if (!props.task) return;
    if (isDirty) {
      const confirmed = window.confirm("Скасувати редагування і відкинути зміни?");
      if (!confirmed) return;
    }
    setTitle(props.task.title);
    setDetails(props.task.details ?? "");
    setProjectId(props.task.project_id ?? "");
    setTaskType(props.task.task_type);
    setScheduledForInput(toLocalInput(props.task.scheduled_for));
    setDueAtInput(toLocalInput(props.task.due_at));
    setEstimatedMinutesInput(props.task.estimated_minutes ? String(props.task.estimated_minutes) : "");
    setEditMode(false);
  }

  function onBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    closeWithGuard();
  }

  const task = props.task;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onBackdropClick}>
      <section className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>Деталі задачі</h3>
          <p className="modal-task-title">{editMode ? "Режим редагування" : "Режим перегляду"}</p>
        </header>

        <div className="modal-body" ref={bodyRef}>
          {!editMode ? (
            <>
              <p className="inbox-main-text">{task.title}</p>
              <p className="inbox-meta">Проєкт: {projectName(task)}</p>
              <p className="inbox-meta">Тип: {taskTypeLabel(task.task_type)}</p>
              <p className="inbox-meta">Статус: {statusLabel(task.status)}</p>
              <p className="inbox-meta">Планування: {task.scheduled_for ? "Заплановано" : "Беклог"}</p>
              <p className="inbox-meta">Час: {timingLabel(task)}</p>
              {task.linked_calendar_event ? (
                <div className="project-group">
                  <p className="inbox-meta">Пов'язано з Google Calendar: так</p>
                  <p className="inbox-meta">
                    Подія: {task.linked_calendar_event.title} ·{" "}
                    {formatLocalDateTime(new Date(task.linked_calendar_event.starts_at))}
                  </p>
                  {task.linked_calendar_event.provider_event_url ? (
                    <div className="inbox-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => props.onOpenLinkedCalendarEvent(task.linked_calendar_event!.provider_event_url!)}
                        disabled={props.busy}
                      >
                        Переглянути в Google Calendar
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {task.status === "cancelled" ? (
                <>
                  <p className="inbox-meta">
                    Причина скасування: {moveReasonLabel(task.last_moved_reason) ?? "Не вказано"}
                  </p>
                  {task.cancel_reason_text ? <p className="inbox-meta">Коментар: {task.cancel_reason_text}</p> : null}
                </>
              ) : null}
              <label>
                Опис
                <textarea value={task.details ?? ""} readOnly rows={6} />
              </label>

              <div className="inbox-actions">
                <button type="button" onClick={() => setEditMode(true)} disabled={props.busy}>
                  Редагувати
                </button>
                <button type="button" onClick={props.onCreateCalendarEvent} disabled={props.busy || task.status === "cancelled"}>
                  {task.linked_calendar_event ? "Створити ще одну подію" : "У Google Calendar"}
                </button>
                {task.status !== "done" ? (
                  <button type="button" onClick={() => props.onAction("done")} disabled={props.busy}>
                    Виконано
                  </button>
                ) : null}
                {(task.status === "planned" || task.status === "in_progress") && (
                  <>
                    <button type="button" onClick={() => props.onAction("reschedule")} disabled={props.busy}>
                      Перенести
                    </button>
                    <button type="button" onClick={() => props.onAction("block")} disabled={props.busy}>
                      Заблокувати
                    </button>
                  </>
                )}
                {task.status === "blocked" ? (
                  <button type="button" onClick={() => props.onAction("unblock")} disabled={props.busy}>
                    Розблокувати
                  </button>
                ) : null}
                {task.status !== "cancelled" && task.status !== "done" ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      const confirmed = window.confirm("Скасувати задачу?");
                      if (confirmed) props.onAction("cancel");
                    }}
                    disabled={props.busy}
                  >
                    Скасувати задачу
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <label>
                Назва
                <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={props.busy} />
              </label>

              <label>
                Опис
                <textarea value={details} onChange={(event) => setDetails(event.target.value)} rows={6} disabled={props.busy} />
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
                Тип
                <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)} disabled={props.busy}>
                  {TASK_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Планований старт
                <input
                  type="datetime-local"
                  value={scheduledForInput}
                  onChange={(event) => setScheduledForInput(event.target.value)}
                  disabled={props.busy}
                />
              </label>

              <label>
                Дедлайн
                <input
                  type="datetime-local"
                  value={dueAtInput}
                  onChange={(event) => setDueAtInput(event.target.value)}
                  disabled={props.busy}
                />
              </label>

              <label>
                Оцінка, хвилин
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={estimatedMinutesInput}
                  onChange={(event) => setEstimatedMinutesInput(event.target.value)}
                  placeholder="Наприклад, 30"
                  disabled={props.busy}
                />
                {estimatedMinutesInvalid ? <p className="error-note">Оцінка має бути додатним цілим числом.</p> : null}
              </label>
            </>
          )}
        </div>

        <footer className="modal-footer">
          <div className="modal-actions">
            {editMode ? (
              <>
                <button type="button" className="ghost" onClick={cancelEdit} disabled={props.busy}>
                  Скасувати
                </button>
                <button
                  type="button"
                  onClick={() =>
                    props.onSave({
                      taskId: task.id,
                      title: title.trim(),
                      details: details.trim(),
                      projectId: projectId || null,
                      taskType,
                      dueAt: toIso(dueAtInput),
                      scheduledFor: toIso(scheduledForInput),
                      estimatedMinutes: parsedEstimatedMinutes
                    })
                  }
                  disabled={props.busy || !title.trim() || estimatedMinutesInvalid}
                >
                  {props.busy ? "Збереження..." : "Зберегти"}
                </button>
              </>
            ) : (
              <button type="button" className="ghost" onClick={closeWithGuard} disabled={props.busy}>
                Закрити
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

