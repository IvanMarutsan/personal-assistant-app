import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { PlanningFlexibility, ProjectItem, TaskCalendarInboundState, TaskItem, TaskStatus, TaskType } from "../types/api";
import { moveReasonLabel } from "../lib/reasons";
import { buildTaskTypeOptions, taskTypeLabel } from "../lib/taskTypes";

type TaskActionKind = "done" | "reschedule" | "block" | "unblock" | "cancel";
type TaskModalMode = "view" | "edit" | "create";

type TaskDetailModalProps = {
  open: boolean;
  task: TaskItem | null;
  projects: ProjectItem[];
  busy: boolean;
  onClose: () => void;
  createDefaults?: {
    title?: string;
    details?: string | null;
    projectId?: string | null;
    taskType?: TaskType;
    dueAt?: string | null;
    scheduledFor?: string | null;
    estimatedMinutes?: number | null;
    planningFlexibility?: PlanningFlexibility | null;
  };
  onSave: (payload: {
    taskId?: string;
    title: string;
    details: string;
    projectId: string | null;
    taskType: TaskType;
    dueAt: string | null;
    scheduledFor: string | null;
    estimatedMinutes: number | null;
    planningFlexibility: PlanningFlexibility | null;
  }) => void;
  onDelete?: () => void;
  onAction: (action: TaskActionKind) => void;
  onCreateCalendarEvent: () => void;
  onOpenLinkedCalendarEvent: (url: string) => void;
  onRetryCalendarSync?: () => void;
  onDetachCalendarLink?: () => void;
  onApplyCalendarInbound?: () => void;
  onKeepCalendarAppVersion?: () => void;
  calendarSyncNotice?: { tone: "success" | "error" | "info"; message: string } | null;
  calendarInboundState?: TaskCalendarInboundState | null;
  initialMode?: TaskModalMode;
  showWorkflowActions?: boolean;
};

const FLEXIBILITY_OPTIONS: Array<{ value: PlanningFlexibility | ""; label: string }> = [
  { value: "", label: "Не вказано" },
  { value: "essential", label: "Обов'язково" },
  { value: "flexible", label: "Гнучко" }
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


function planningFlexibilityLabel(value: PlanningFlexibility | null | undefined): string {
  if (value === "essential") return "Обов'язково";
  if (value === "flexible") return "Гнучко";
  return "Не вказано";
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

function deleteCalendarBehaviorLabel(task: TaskItem): string | null {
  if (!task.linked_calendar_event) return null;
  if (task.calendar_sync_mode === "app_managed") {
    return "Видалення задачі також прибере синхронізовану подію з Google Calendar.";
  }
  return "Видалення прибере лише задачу. Подія в календарі лишиться без змін.";
}
function canRetryCalendarSync(task: TaskItem): boolean {
  if (task.calendar_sync_mode === "manual") return false;
  if (task.status === "cancelled") return false;

  const recoverableManagedLink =
    task.calendar_sync_mode === "app_managed" && task.calendar_provider === "google" && !!task.calendar_event_id;
  const recoverableScheduledState =
    !!task.scheduled_for &&
    (task.calendar_sync_mode === "app_managed" || !!task.calendar_sync_error || !!task.calendar_event_id || task.calendar_provider === "google");

  return recoverableManagedLink || recoverableScheduledState;
}

function retryCalendarLabel(task: TaskItem): string {
  const needsRecreate =
    task.calendar_sync_mode === "app_managed" &&
    (!!task.calendar_sync_error || !task.linked_calendar_event || !task.calendar_event_id);
  return needsRecreate ? "Створити подію заново" : "Пересинхронізувати";
}

function detachCalendarLabel(task: TaskItem): string | null {
  if (!task.linked_calendar_event) return null;
  if (task.calendar_sync_mode === "app_managed") return "Від'єднати і прибрати з Google Calendar";
  if (task.calendar_provider === "google" || task.calendar_sync_mode === "manual") return "Від'єднати від задачі";
  return null;
}

function detachCalendarConfirm(task: TaskItem): string | null {
  if (!task.linked_calendar_event) return null;
  if (task.calendar_sync_mode === "app_managed") {
    return "Від'єднати задачу і прибрати синхронізовану подію з Google Calendar?";
  }
  if (task.calendar_provider === "google" || task.calendar_sync_mode === "manual") {
    return "Від'єднати подію лише в додатку? Подія в Google Calendar лишиться без змін.";
  }
  return null;
}

function calendarSyncStateSummary(task: TaskItem): string | null {
  if (task.calendar_sync_error) return "\u0417\u0432\u2019\u044f\u0437\u043e\u043a \u0456\u0437 Google Calendar \u043f\u043e\u0442\u0440\u0435\u0431\u0443\u0454 \u0443\u0432\u0430\u0433\u0438.";
  if (task.calendar_sync_mode === "app_managed" && task.linked_calendar_event) return "\u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u043e \u0437 Google Calendar.";
  if (task.calendar_sync_mode === "manual" && task.linked_calendar_event) return "\u041f\u043e\u0434\u0456\u044e \u043f\u0440\u0438\u0432\u2019\u044f\u0437\u0430\u043d\u043e \u0432\u0440\u0443\u0447\u043d\u0443.";
  if (task.scheduled_for) return "\u0417\u0432\u2019\u044f\u0437\u043a\u0443 \u0437 Google Calendar \u0437\u0430\u0440\u0430\u0437 \u043d\u0435\u043c\u0430\u0454.";
  return null;
}

function calendarSyncActionHint(task: TaskItem): string | null {
  if (task.calendar_sync_error) return "\u041c\u043e\u0436\u043d\u0430 \u043f\u0435\u0440\u0435\u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u0443\u0432\u0430\u0442\u0438, \u0441\u0442\u0432\u043e\u0440\u0438\u0442\u0438 \u043f\u043e\u0434\u0456\u044e \u0437\u0430\u043d\u043e\u0432\u043e \u0430\u0431\u043e \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u0437\u0432\u2019\u044f\u0437\u043e\u043a.";
  if (task.calendar_sync_mode === "app_managed" && task.linked_calendar_event) return "\u041c\u043e\u0436\u043d\u0430 \u0432\u0456\u0434\u043a\u0440\u0438\u0442\u0438 \u043f\u043e\u0434\u0456\u044e \u0430\u0431\u043e \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u0437\u0432\u2019\u044f\u0437\u043e\u043a.";
  if (task.calendar_sync_mode === "manual" && task.linked_calendar_event) return "\u041f\u043e\u0434\u0456\u044f \u043b\u0438\u0448\u0430\u0454\u0442\u044c\u0441\u044f \u0440\u0443\u0447\u043d\u043e\u044e. \u0407\u0457 \u043c\u043e\u0436\u043d\u0430 \u043b\u0438\u0448\u0435 \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u0432 \u0434\u043e\u0434\u0430\u0442\u043a\u0443.";
  if (task.scheduled_for) return "\u0417\u0430 \u043f\u043e\u0442\u0440\u0435\u0431\u0438 \u043c\u043e\u0436\u043d\u0430 \u0441\u0442\u0432\u043e\u0440\u0438\u0442\u0438 \u043d\u043e\u0432\u0443 \u043f\u043e\u0434\u0456\u044e \u0430\u0431\u043e \u0432\u0456\u0434\u043d\u043e\u0432\u0438\u0442\u0438 \u0437\u0432\u2019\u044f\u0437\u043e\u043a.";
  return null;
}

function calendarInboundMessage(state: TaskCalendarInboundState | null | undefined): string | null {
  if (!state || state.status === "healthy" || state.status === "manual" || state.status === "not_linked") return null;
  return state.message;
}
function timingLabel(task: TaskItem): string {
  const scheduled = task.scheduled_for ? formatLocalDateTime(new Date(task.scheduled_for)) : null;
  const due = task.due_at ? formatLocalDateTime(new Date(task.due_at)) : null;
  const estimate = formatEstimate(task.estimated_minutes);

  if (!scheduled && !due) return `Беклог · Оцінка: ${estimate}`;
  if (scheduled && due) return `Планований старт: ${scheduled} · Дедлайн: ${due} · Оцінка: ${estimate}`;
  if (scheduled) return `Планований старт: ${scheduled} · Оцінка: ${estimate}`;
  return `Беклог · Дедлайн: ${due} · Оцінка: ${estimate}`;
}

export function TaskDetailModal(props: TaskDetailModalProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [projectId, setProjectId] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("admin");
  const [scheduledForInput, setScheduledForInput] = useState("");
  const [dueAtInput, setDueAtInput] = useState("");
  const [estimatedMinutesInput, setEstimatedMinutesInput] = useState("");
  const [planningFlexibility, setPlanningFlexibility] = useState<PlanningFlexibility | null>(null);

  const initialMode = props.initialMode ?? "view";
  const isCreateMode = initialMode === "create";
  const showWorkflowActions = props.showWorkflowActions ?? true;
  const taskTypeOptions = useMemo(() => buildTaskTypeOptions(taskType), [taskType]);

  useEffect(() => {
    if (!props.open) return;
    if (isCreateMode) {
      setEditMode(true);
      setTitle(props.createDefaults?.title ?? "");
      setDetails(props.createDefaults?.details ?? "");
      setProjectId(props.createDefaults?.projectId ?? "");
      setTaskType(props.createDefaults?.taskType ?? "admin");
      setScheduledForInput(toLocalInput(props.createDefaults?.scheduledFor ?? null));
      setDueAtInput(toLocalInput(props.createDefaults?.dueAt ?? null));
      setEstimatedMinutesInput(props.createDefaults?.estimatedMinutes ? String(props.createDefaults.estimatedMinutes) : "");
      setPlanningFlexibility(props.createDefaults?.planningFlexibility ?? null);
      return;
    }

    if (!props.task) return;
    setEditMode(initialMode === "edit");
    setTitle(props.task.title);
    setDetails(props.task.details ?? "");
    setProjectId(props.task.project_id ?? "");
    setTaskType(props.task.task_type);
    setScheduledForInput(toLocalInput(props.task.scheduled_for));
    setDueAtInput(toLocalInput(props.task.due_at));
    setEstimatedMinutesInput(props.task.estimated_minutes ? String(props.task.estimated_minutes) : "");
    setPlanningFlexibility(props.task.planning_flexibility ?? null);
  }, [props.open, props.task?.id, initialMode, isCreateMode, props.task, props.createDefaults]);

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
  }, [props.open, props.task?.id, editMode, isCreateMode]);

  const parsedEstimatedMinutes = useMemo(() => parseEstimatedMinutes(estimatedMinutesInput), [estimatedMinutesInput]);
  const estimatedMinutesInvalid = estimatedMinutesInput.trim().length > 0 && parsedEstimatedMinutes === null;

  const isDirty = useMemo(() => {
    if (isCreateMode) {
      return Boolean(
        title.trim() ||
          details.trim() ||
          projectId ||
          taskType !== "admin" ||
          scheduledForInput ||
          dueAtInput ||
          estimatedMinutesInput.trim() ||
          planningFlexibility
      );
    }

    if (!props.task) return false;
    const sameTitle = title.trim() === props.task.title;
    const sameDetails = details.trim() === (props.task.details ?? "");
    const sameProject = (projectId || null) === props.task.project_id;
    const sameType = taskType === props.task.task_type;
    const sameScheduled = toIso(scheduledForInput) === (props.task.scheduled_for ?? null);
    const sameDue = toIso(dueAtInput) === (props.task.due_at ?? null);
    const sameEstimate = parsedEstimatedMinutes === (props.task.estimated_minutes ?? null);
    const sameFlexibility = planningFlexibility === (props.task.planning_flexibility ?? null);
    return !(sameTitle && sameDetails && sameProject && sameType && sameScheduled && sameDue && sameEstimate && sameFlexibility);
  }, [
    props.task,
    title,
    details,
    projectId,
    taskType,
    scheduledForInput,
    dueAtInput,
    parsedEstimatedMinutes,
    planningFlexibility,
    isCreateMode,
    estimatedMinutesInput
  ]);

  if (!props.open || (!isCreateMode && !props.task)) return null;

  function closeWithGuard() {
    if (!editMode || !isDirty) {
      props.onClose();
      return;
    }
    const confirmed = window.confirm(isCreateMode ? "Є незбережені дані. Закрити без створення задачі?" : "Є незбережені зміни. Закрити без збереження?");
    if (confirmed) props.onClose();
  }

  function cancelEdit() {
    if (isCreateMode) {
      if (isDirty) {
        const confirmed = window.confirm("Скасувати створення і відкинути введені дані?");
        if (!confirmed) return;
      }
      props.onClose();
      return;
    }

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
    setPlanningFlexibility(props.task.planning_flexibility ?? null);
    if (initialMode === "edit") {
      props.onClose();
      return;
    }
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
          <h3>{isCreateMode ? "Створити задачу" : "Деталі задачі"}</h3>
          <p className="modal-task-title">
            {isCreateMode ? "Нова задача" : editMode ? "Режим редагування" : "Режим перегляду"}
          </p>
        </header>

        <div className="modal-body" ref={bodyRef}>
          {!editMode && task ? (
            <>
              <p className="inbox-main-text">{task.title}</p>
              <p className="inbox-meta">Проєкт: {projectName(task)}</p>
              <p className="inbox-meta">Тип: {taskTypeLabel(task.task_type)}</p>
              <p className="inbox-meta">Статус: {statusLabel(task.status)}</p>
              <p className="inbox-meta">Планування: {task.scheduled_for ? "Заплановано" : "Беклог"}</p>
              <p className="inbox-meta">Гнучкість у плані: {planningFlexibilityLabel(task.planning_flexibility)}</p>
              <p className="inbox-meta">Час: {timingLabel(task)}</p>
              {calendarSyncStateSummary(task) ? <p className="inbox-meta">{calendarSyncStateSummary(task)}</p> : null}
              {calendarSyncActionHint(task) ? <p className="inbox-meta">{calendarSyncActionHint(task)}</p> : null}
              {task.calendar_sync_mode === "app_managed" ? (
                <>
                  <p className="inbox-meta">{"\u0422\u0440\u0438\u0432\u0430\u043b\u0456\u0441\u0442\u044c \u043f\u043e\u0434\u0456\u0457 \u0431\u0435\u0440\u0435\u0442\u044c\u0441\u044f \u0437 \u043e\u0446\u0456\u043d\u043a\u0438 \u0437\u0430\u0434\u0430\u0447\u0456."}</p>
                  <p className="inbox-meta">{"\u041f\u0456\u0441\u043b\u044f \"\u0412\u0438\u043a\u043e\u043d\u0430\u043d\u043e\u201d \u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u0430 \u043f\u043e\u0434\u0456\u044f \u043f\u0440\u0438\u0431\u0438\u0440\u0430\u0454\u0442\u044c\u0441\u044f \u0437 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044f."}</p>
                </>
              ) : null}
              {calendarInboundMessage(props.calendarInboundState) ? (
                <p className={props.calendarInboundState?.status === "changed" ? "error-note" : "inbox-meta"}>
                  {calendarInboundMessage(props.calendarInboundState)}
                </p>
              ) : null}
              {props.calendarInboundState?.status === "changed" && props.onApplyCalendarInbound ? (
                <div className="inbox-actions">
                  <button type="button" className="ghost" onClick={props.onApplyCalendarInbound} disabled={props.busy}>
                    Застосувати зміни з календаря
                  </button>
                </div>
              ) : null}
              {props.calendarSyncNotice ? (
                <p className={props.calendarSyncNotice.tone === "error" ? "error-note" : "inbox-meta"}>
                  {props.calendarSyncNotice.message}
                </p>
              ) : null}
              {!task.linked_calendar_event && props.onRetryCalendarSync && canRetryCalendarSync(task) ? (
                <div className="project-group">
                  <div className="inbox-actions">
                    <button type="button" className="ghost" onClick={props.onRetryCalendarSync} disabled={props.busy}>
                      {retryCalendarLabel(task)}
                    </button>
                  </div>
                </div>
              ) : null}
              {task.linked_calendar_event ? (
                <div className="project-group">
                  <p className="inbox-meta">{"\u041f\u043e\u0434\u0456\u044f \u0432 Google Calendar"}</p>
                  <p className="inbox-meta">
                    {"\u041d\u0430\u0437\u0432\u0430:"} {task.linked_calendar_event.title} - {" "}
                    {formatLocalDateTime(new Date(task.linked_calendar_event.starts_at))}
                  </p>
                  <p className="inbox-meta">{deleteCalendarBehaviorLabel(task)}</p>
                  <div className="inbox-actions">
                    {task.linked_calendar_event.provider_event_url ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => props.onOpenLinkedCalendarEvent(task.linked_calendar_event!.provider_event_url!)}
                        disabled={props.busy}
                      >
                        {"\u0412\u0456\u0434\u043a\u0440\u0438\u0442\u0438 \u0432 Google Calendar"}
                      </button>
                    ) : null}
                    {props.onRetryCalendarSync && canRetryCalendarSync(task) ? (
                      <button type="button" className="ghost" onClick={props.onRetryCalendarSync} disabled={props.busy}>
                        {retryCalendarLabel(task)}
                      </button>
                    ) : null}
                    {props.onDetachCalendarLink && detachCalendarLabel(task) ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          const confirmText = detachCalendarConfirm(task);
                          if (!confirmText) return;
                          const confirmed = window.confirm(confirmText);
                          if (confirmed) props.onDetachCalendarLink?.();
                        }}
                        disabled={props.busy}
                      >
                        {detachCalendarLabel(task)}
                      </button>
                    ) : null}
                  </div>
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
                {props.onDelete ? (
                  <button type="button" className="danger" onClick={props.onDelete} disabled={props.busy}>
                    Видалити
                  </button>
                ) : null}
                {showWorkflowActions ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (task.linked_calendar_event?.provider_event_url) {
                          props.onOpenLinkedCalendarEvent(task.linked_calendar_event.provider_event_url);
                          return;
                        }
                        props.onCreateCalendarEvent();
                      }}
                      disabled={props.busy || task.status === "cancelled"}
                    >
                      {task.linked_calendar_event ? "Відкрити в Google Calendar" : "У Google Calendar"}
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
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <label>
                Назва
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Назва задачі"
                  disabled={props.busy}
                />
              </label>

              <label>
                Опис
                <textarea
                  value={details}
                  onChange={(event) => setDetails(event.target.value)}
                  rows={6}
                  placeholder="Опис задачі (необов'язково)"
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
                Тип
                <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)} disabled={props.busy}>
                  {taskTypeOptions.map((option) => (
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

              <label>
                Гнучкість у плані
                <select
                  value={planningFlexibility ?? ""}
                  onChange={(event) => setPlanningFlexibility((event.target.value || null) as PlanningFlexibility | null)}
                  disabled={props.busy}
                >
                  {FLEXIBILITY_OPTIONS.map((option) => (
                    <option key={option.value || "empty"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
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
                      taskId: task?.id,
                      title: title.trim(),
                      details: details.trim(),
                      projectId: projectId || null,
                      taskType,
                      dueAt: toIso(dueAtInput),
                      scheduledFor: toIso(scheduledForInput),
                      estimatedMinutes: parsedEstimatedMinutes,
                      planningFlexibility
                    })
                  }
                  disabled={props.busy || !title.trim() || estimatedMinutesInvalid}
                >
                  {props.busy ? (isCreateMode ? "Створення..." : "Збереження...") : isCreateMode ? "Створити" : "Зберегти"}
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















