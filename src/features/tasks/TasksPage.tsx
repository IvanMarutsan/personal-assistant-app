import { useEffect, useMemo, useState } from "react";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { TaskActionModal } from "../../components/TaskActionModal";
import { TaskDetailModal } from "../../components/TaskDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  applyTaskCalendarInbound,
  createGoogleCalendarEvent,
  createTask,
  deleteTask,
  detachTaskCalendarLink as detachTaskCalendarLinkRequest,
  getGoogleCalendarStatus,
  inspectTaskCalendarInbound,
  keepTaskCalendarLocalVersion,
  retryTaskCalendarSync as retryTaskCalendarSyncRequest,
  getProjects,
  getTasks,
  updateTask,
  updateTaskStatus
} from "../../lib/api";
import { moveReasonLabel } from "../../lib/reasons";
import { formatTaskTimingTone, isBacklogTask, parseTaskDate, planningFlexibilityLabel } from "../../lib/taskTiming";
import type { GoogleCalendarStatus, MoveReasonCode, ProjectItem, TaskCalendarInboundState, TaskItem, TaskType } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";
const TASK_TYPE_FILTERS: Array<{ label: string; value: TaskType }> = [
  { label: "Глибока робота", value: "deep_work" },
  { label: "Швидка комунікація", value: "quick_communication" },
  { label: "Адміністративне", value: "admin_operational" },
  { label: "Регулярне важливе", value: "recurring_essential" },
  { label: "Особисто важливе", value: "personal_essential" },
  { label: "Колись", value: "someday" }
];

type TaskStatusScope = "active" | "completed" | "blocked" | "cancelled";
type TaskActionKind = "postpone" | "reschedule" | "block" | "unblock" | "cancel";
type TaskModalMode = "view" | "create";

type PendingAction = {
  task: TaskItem;
  action: TaskActionKind;
};

type CalendarNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

function calendarLinkHint(task: TaskItem): string | null {
  if (task.calendar_sync_error) return "Google Calendar: \u043f\u043e\u0442\u0440\u0456\u0431\u043d\u0430 \u0443\u0432\u0430\u0433\u0430";
  if (task.calendar_sync_mode === "app_managed" && task.linked_calendar_event) return "Google Calendar: \u0441\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u043e\u0432\u0430\u043d\u043e";
  if (task.calendar_sync_mode === "manual" && task.linked_calendar_event) return "Google Calendar: \u0440\u0443\u0447\u043d\u0438\u0439 \u0437\u0432\u2019\u044f\u0437\u043e\u043a";
  return null;
}

function projectName(task: TaskItem): string {
  if (!task.projects) return "Без проєкту";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "Без проєкту";
  return task.projects.name ?? "Без проєкту";
}

function taskTypeLabel(value: TaskType): string {
  switch (value) {
    case "deep_work":
      return "Глибока робота";
    case "quick_communication":
      return "Швидка комунікація";
    case "admin_operational":
      return "Адміністративне";
    case "recurring_essential":
      return "Регулярне важливе";
    case "personal_essential":
      return "Особисто важливе";
    case "someday":
      return "Колись";
  }
}

function statusLabel(status: TaskItem["status"]): string {
  switch (status) {
    case "planned":
      return "Заплановано";
    case "in_progress":
      return "В роботі";
    case "blocked":
      return "Заблоковано";
    case "done":
      return "Виконано";
    case "cancelled":
      return "Скасовано";
  }
}

function statusScopeMatch(task: TaskItem, scopes: TaskStatusScope[]): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => {
    if (scope === "active") return task.status === "planned" || task.status === "in_progress";
    if (scope === "completed") return task.status === "done";
    if (scope === "blocked") return task.status === "blocked";
    if (scope === "cancelled") return task.status === "cancelled";
    return false;
  });
}

function groupByProject(tasks: TaskItem[]): Array<{ project: string; tasks: TaskItem[] }> {
  const map = tasks.reduce<Map<string, TaskItem[]>>((acc, task) => {
    const key = projectName(task);
    const existing = acc.get(key) ?? [];
    existing.push(task);
    acc.set(key, existing);
    return acc;
  }, new Map());

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b, "uk-UA"))
    .map(([project, projectTasks]) => ({ project, tasks: projectTasks }));
}

export function TasksPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workingTaskId, setWorkingTaskId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<TaskType[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<TaskStatusScope[]>(["active"]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [taskModalMode, setTaskModalMode] = useState<TaskModalMode>("view");
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [pendingCalendarTask, setPendingCalendarTask] = useState<TaskItem | null>(null);
  const [calendarCreating, setCalendarCreating] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarNotice, setCalendarNotice] = useState<CalendarNotice | null>(null);
  const [calendarInboundState, setCalendarInboundState] = useState<TaskCalendarInboundState | null>(null);
  const diagnostics = useDiagnostics();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";

  async function loadTasks() {
    if (!sessionToken) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_tasks", { route: "/tasks" });

    try {
      const tasks = await getTasks(sessionToken);
      setItems(tasks);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("tasks_data");
    } catch (loadError) {
      if (loadError instanceof ApiError) {
        diagnostics.trackFailure({
          path: loadError.path,
          status: loadError.status,
          code: loadError.code,
          message: loadError.message,
          details: loadError.details
        });
      }
      setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити задачі");
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects() {
    if (!sessionToken) {
      setProjects([]);
      return;
    }
    try {
      const projectItems = await getProjects(sessionToken);
      setProjects(projectItems);
    } catch {
      setProjects([]);
    }
  }

  async function loadCalendarStatus() {
    if (!sessionToken) {
      setCalendarStatus(null);
      return;
    }
    try {
      const status = await getGoogleCalendarStatus(sessionToken);
      setCalendarStatus(status);
    } catch {
      setCalendarStatus(null);
    }
  }

  useEffect(() => {
    void Promise.all([loadTasks(), loadProjects(), loadCalendarStatus()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!sessionToken || !activeTask || activeTask.calendar_sync_mode !== "app_managed" || !activeTask.calendar_event_id) {
      setCalendarInboundState(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await inspectTaskCalendarInbound({ sessionToken, taskId: activeTask.id });
        if (!cancelled) setCalendarInboundState(state);
      } catch {
        if (!cancelled) setCalendarInboundState(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTask?.id, activeTask?.calendar_event_id, activeTask?.calendar_sync_mode, sessionToken]);

  async function createCalendarFromTask(payload: {
    title: string;
    description: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
  }) {
    if (!sessionToken || !pendingCalendarTask) return;
    setCalendarCreating(true);
    setCalendarError(null);
    diagnostics.trackAction("create_calendar_event_from_task", { taskId: pendingCalendarTask.id });
    try {
      await createGoogleCalendarEvent({
        sessionToken,
        title: payload.title,
        description: payload.description || undefined,
        startAt: payload.startAt,
        endAt: payload.endAt,
        timezone: payload.timezone,
        sourceTaskId: pendingCalendarTask.id
      });
      setPendingCalendarTask(null);
      setActiveTask(null);
      await loadTasks();
    } catch (error) {
      if (error instanceof ApiError) {
        diagnostics.trackFailure({
          path: error.path,
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details
        });
      }
      setCalendarError(error instanceof Error ? error.message : "Не вдалося створити подію в Google Calendar.");
    } finally {
      setCalendarCreating(false);
    }
  }

  function toggleType(type: TaskType) {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((value) => value !== type) : [...prev, type]
    );
  }

  function toggleStatus(scope: TaskStatusScope) {
    setSelectedStatuses((prev) =>
      prev.includes(scope) ? prev.filter((value) => value !== scope) : [...prev, scope]
    );
  }

  const counts = useMemo(
    () => ({
      active: items.filter((task) => task.status === "planned" || task.status === "in_progress").length,
      completed: items.filter((task) => task.status === "done").length,
      blocked: items.filter((task) => task.status === "blocked").length,
      cancelled: items.filter((task) => task.status === "cancelled").length
    }),
    [items]
  );

  const filteredItems = useMemo(
    () =>
      items.filter((task) => {
        const typeOk = selectedTypes.length === 0 ? true : selectedTypes.includes(task.task_type);
        const statusOk = statusScopeMatch(task, selectedStatuses);
        return typeOk && statusOk;
      }),
    [items, selectedStatuses, selectedTypes]
  );

  const scheduledItems = useMemo(() => {
    return [...filteredItems]
      .filter((task) => Boolean(task.scheduled_for))
      .sort((a, b) => {
        const aTs = parseTaskDate(a.scheduled_for)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTs = parseTaskDate(b.scheduled_for)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTs !== bTs) return aTs - bTs;
        return a.title.localeCompare(b.title, "uk-UA");
      });
  }, [filteredItems]);

  const backlogItems = useMemo(() => filteredItems.filter((task) => isBacklogTask(task)), [filteredItems]);

  const scheduledGroups = useMemo(() => groupByProject(scheduledItems), [scheduledItems]);
  const backlogGroups = useMemo(() => groupByProject(backlogItems), [backlogItems]);

  const quickCommunicationOpenCount = useMemo(
    () =>
      items.filter(
        (task) =>
          task.task_type === "quick_communication" &&
          (task.status === "planned" || task.status === "in_progress")
      ).length,
    [items]
  );

  async function runDone(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("update_task_status", { taskId: task.id, status: "done" });

    try {
      await updateTaskStatus({
        sessionToken,
        taskId: task.id,
        status: "done"
      });
      if (activeTask?.id === task.id) setActiveTask(null);
      await loadTasks();
    } catch (actionError) {
      if (actionError instanceof ApiError) {
        diagnostics.trackFailure({
          path: actionError.path,
          status: actionError.status,
          code: actionError.code,
          message: actionError.message,
          details: actionError.details
        });
      }
      setError(actionError instanceof Error ? actionError.message : "Не вдалося оновити задачу");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function confirmAction(payload: {
    reasonCode: MoveReasonCode;
    reasonText?: string;
    postponeMinutes?: number;
    rescheduleTo?: string;
  }) {
    if (!pendingAction || !sessionToken) return;

    setWorkingTaskId(pendingAction.task.id);
    setError(null);
    diagnostics.trackAction("update_task_status", {
      taskId: pendingAction.task.id,
      action: pendingAction.action
    });

    try {
      const common = {
        sessionToken,
        taskId: pendingAction.task.id,
        reasonCode: payload.reasonCode,
        reasonText: payload.reasonText
      };

      if (pendingAction.action === "postpone") {
        await updateTaskStatus({
          ...common,
          status: "planned",
          postponeMinutes: payload.postponeMinutes
        });
      }

      if (pendingAction.action === "reschedule") {
        await updateTaskStatus({
          ...common,
          status: "planned",
          rescheduleTo: payload.rescheduleTo
        });
      }

      if (pendingAction.action === "block") {
        await updateTaskStatus({
          ...common,
          status: "blocked"
        });
      }

      if (pendingAction.action === "unblock") {
        await updateTaskStatus({
          ...common,
          status: "planned"
        });
      }

      if (pendingAction.action === "cancel") {
        await updateTaskStatus({
          ...common,
          status: "cancelled"
        });
      }

      setPendingAction(null);
      setActiveTask(null);
      await loadTasks();
    } catch (actionError) {
      if (actionError instanceof ApiError) {
        diagnostics.trackFailure({
          path: actionError.path,
          status: actionError.status,
          code: actionError.code,
          message: actionError.message,
          details: actionError.details
        });
      }
      setError(actionError instanceof Error ? actionError.message : "Не вдалося оновити задачу");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function deleteCurrentTask() {
    if (!sessionToken || !activeTask) return;

    const calendarWarning = activeTask.linked_calendar_event
      ? activeTask.calendar_sync_mode === "app_managed"
        ? " Задача синхронізована з Google Calendar, тому пов'язану подію теж буде видалено."
        : " Задача пов'язана з подією Google Calendar, але сама подія не буде видалена."
      : "";
    const confirmed = window.confirm(`Видалити задачу "${activeTask.title}"?${calendarWarning}`);
    if (!confirmed) return;

    setWorkingTaskId(activeTask.id);
    setError(null);
    diagnostics.trackAction("delete_task", { taskId: activeTask.id });

    try {
      await deleteTask({ sessionToken, taskId: activeTask.id });
      setActiveTask(null);
      setTaskModalMode("view");
      setCalendarNotice(null);
      setCalendarNotice(null);
      await loadTasks();
    } catch (deleteError) {
      if (deleteError instanceof ApiError) {
        diagnostics.trackFailure({
          path: deleteError.path,
          status: deleteError.status,
          code: deleteError.code,
          message: deleteError.message,
          details: deleteError.details
        });
      }
      setError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити задачу");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function saveTask(payload: {
    taskId?: string;
    title: string;
    details: string;
    projectId: string | null;
    taskType: TaskType;
    dueAt: string | null;
    scheduledFor: string | null;
    estimatedMinutes: number | null;
    planningFlexibility: "essential" | "flexible" | null;
  }) {
    if (!sessionToken) return;

    const isCreate = taskModalMode === "create";
    setWorkingTaskId(payload.taskId ?? "create_task");
    setError(null);
    diagnostics.trackAction(isCreate ? "create_task_manual" : "update_task_fields", {
      taskId: payload.taskId ?? null
    });

    try {
      if (isCreate) {
        await createTask({
          sessionToken,
          title: payload.title,
          details: payload.details,
          projectId: payload.projectId,
          taskType: payload.taskType,
          dueAt: payload.dueAt,
          scheduledFor: payload.scheduledFor,
          estimatedMinutes: payload.estimatedMinutes,
          planningFlexibility: payload.planningFlexibility
        });
      } else if (payload.taskId) {
        await updateTask({
          sessionToken,
          taskId: payload.taskId,
          title: payload.title,
          details: payload.details,
          projectId: payload.projectId,
          taskType: payload.taskType,
          dueAt: payload.dueAt,
          scheduledFor: payload.scheduledFor,
          estimatedMinutes: payload.estimatedMinutes,
          planningFlexibility: payload.planningFlexibility
        });
      }

      setActiveTask(null);
      setTaskModalMode("view");
      await loadTasks();
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        diagnostics.trackFailure({
          path: saveError.path,
          status: saveError.status,
          code: saveError.code,
          message: saveError.message,
          details: saveError.details
        });
      }
      setError(saveError instanceof Error ? saveError.message : isCreate ? "Не вдалося створити задачу" : "Не вдалося зберегти зміни задачі");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function retryCalendarSync(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("retry_task_calendar_sync", { taskId: task.id });

    try {
      await retryTaskCalendarSyncRequest({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: task.calendar_sync_error || !task.linked_calendar_event || !task.calendar_event_id ? "\u041f\u043e\u0434\u0456\u044e \u0432 Google Calendar \u0432\u0456\u0434\u043d\u043e\u0432\u043b\u0435\u043d\u043e." : "\u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0456\u0437\u0430\u0446\u0456\u044e \u0437 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u0435\u043c \u043e\u043d\u043e\u0432\u043b\u0435\u043d\u043e."
      });
      await loadTasks();
    } catch (retryError) {
      if (retryError instanceof ApiError) {
        diagnostics.trackFailure({
          path: retryError.path,
          status: retryError.status,
          code: retryError.code,
          message: retryError.message,
          details: retryError.details
        });
      }
      setError(retryError instanceof Error ? retryError.message : "Не вдалося пересинхронізувати задачу");
    } finally {
      setWorkingTaskId(null);
    }
  }
  async function applyInboundCalendarChange(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("apply_task_calendar_inbound", { taskId: task.id });

    try {
      const state = await applyTaskCalendarInbound({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: state.message ?? "Зміни з Google Calendar застосовано."
      });
      await loadTasks();
    } catch (applyError) {
      if (applyError instanceof ApiError) {
        diagnostics.trackFailure({
          path: applyError.path,
          status: applyError.status,
          code: applyError.code,
          message: applyError.message,
          details: applyError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "Не вдалося застосувати зміни з Google Calendar." });
      setError(applyError instanceof Error ? applyError.message : "Не вдалося застосувати зміни з Google Calendar.");
    } finally {
      setWorkingTaskId(null);
    }
  }
  async function keepCalendarAppVersion(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("keep_task_calendar_app_version", { taskId: task.id });

    try {
      const state = await keepTaskCalendarLocalVersion({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: state.message ?? "Версію з додатку збережено в Google Calendar."
      });
      await loadTasks();
    } catch (keepError) {
      if (keepError instanceof ApiError) {
        diagnostics.trackFailure({
          path: keepError.path,
          status: keepError.status,
          code: keepError.code,
          message: keepError.message,
          details: keepError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "Не вдалося залишити версію з додатку." });
      setError(keepError instanceof Error ? keepError.message : "Не вдалося залишити версію з додатку.");
    } finally {
      setWorkingTaskId(null);
    }
  }
  async function detachCalendarLink(task: TaskItem) {
    if (!sessionToken) {
      setError("???????? ??????????? ? ???????.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("detach_task_calendar_link", { taskId: task.id });

    try {
      await detachTaskCalendarLinkRequest({ sessionToken, taskId: task.id });
      setCalendarNotice({
        tone: "success",
        message: task.calendar_sync_mode === "app_managed" ? "\u0417\u0432\u2019\u044f\u0437\u043e\u043a \u0456\u0437 Google Calendar \u043f\u0440\u0438\u0431\u0440\u0430\u043d\u043e." : "\u041f\u043e\u0434\u0456\u044e \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u043d\u043e \u0432\u0456\u0434 \u0437\u0430\u0434\u0430\u0447\u0456."
      });
      await loadTasks();
    } catch (detachError) {
      if (detachError instanceof ApiError) {
        diagnostics.trackFailure({
          path: detachError.path,
          status: detachError.status,
          code: detachError.code,
          message: detachError.message,
          details: detachError.details
        });
      }
      setCalendarNotice({ tone: "error", message: "\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u043f\u043e\u0434\u0456\u044e." });
      setError(detachError instanceof Error ? detachError.message : "\u041d\u0435 \u0432\u0434\u0430\u043b\u043e\u0441\u044f \u0432\u0456\u0434\u2019\u0454\u0434\u043d\u0430\u0442\u0438 \u043f\u043e\u0434\u0456\u044e.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  function openCreateTask() {
    setTaskModalMode("create");
    setActiveTask(null);
    setCalendarNotice(null);
    setError(null);
  }

  function renderTaskGroups(groups: Array<{ project: string; tasks: TaskItem[] }>, emptyMessage: string) {
    if (groups.length === 0) {
      return <p className="empty-note">{emptyMessage}</p>;
    }

    return groups.map(({ project, tasks }) => (
      <section key={project} className="project-group">
        <h4>{project}</h4>
        <ul className="inbox-list">
          {tasks.map((task) => {
            const timing = formatTaskTimingTone(task);
            return (
              <li key={task.id} className="inbox-item">
                <p className="inbox-main-text">
                  {task.title}
                  {task.is_protected_essential ? <span className="essential-badge">Захищене важливе</span> : null}
                  {task.planning_flexibility ? <span className={`planning-badge planning-badge--${task.planning_flexibility}`}>{planningFlexibilityLabel(task.planning_flexibility)}</span> : null}
                </p>
                <p className="inbox-meta">
                  {taskTypeLabel(task.task_type)} · {statusLabel(task.status)}
                </p>
                {task.status === "cancelled" ? (
                  <p className="inbox-meta">
                    Причина: {moveReasonLabel(task.last_moved_reason) ?? "Не вказано"}
                    {task.cancel_reason_text ? ` · ${task.cancel_reason_text}` : ""}
                  </p>
                ) : null}
                <p className={timing.tone === "warn" ? "error-note" : "inbox-meta"}>{timing.label}</p>
                {calendarLinkHint(task) ? <p className="inbox-meta">{calendarLinkHint(task)}</p> : task.linked_calendar_event ? <p className="inbox-meta">Пов'язано з Google Calendar</p> : null}
                <div className="inbox-actions">
                  {task.status !== "done" ? (
                    <button onClick={() => void runDone(task)} disabled={workingTaskId === task.id}>
                      Виконано
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setTaskModalMode("view");
                      setActiveTask(task);
                    }}
                  >
                    Деталі
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  }

  return (
    <section className="panel">
      <h2>Задачі</h2>
      <p>Заплановані задачі відокремлені від беклогу, без автоматичного перепланування.</p>

      <div className="toolbar-row">
        <button type="button" onClick={openCreateTask} disabled={!sessionToken || loading || workingTaskId !== null}>
          Створити задачу
        </button>
      </div>

      <div className="filters-wrap">
        <details className="filter-dropdown">
          <summary>Статус ({selectedStatuses.length || "всі"})</summary>
          <div className="filter-dropdown-body">
            <label>
              <input
                type="checkbox"
                checked={selectedStatuses.includes("active")}
                onChange={() => toggleStatus("active")}
              />
              Активні ({counts.active})
            </label>
            <label>
              <input
                type="checkbox"
                checked={selectedStatuses.includes("completed")}
                onChange={() => toggleStatus("completed")}
              />
              Виконані ({counts.completed})
            </label>
            <label>
              <input
                type="checkbox"
                checked={selectedStatuses.includes("blocked")}
                onChange={() => toggleStatus("blocked")}
              />
              Заблоковані ({counts.blocked})
            </label>
            <label>
              <input
                type="checkbox"
                checked={selectedStatuses.includes("cancelled")}
                onChange={() => toggleStatus("cancelled")}
              />
              Скасовані ({counts.cancelled})
            </label>
          </div>
        </details>

        <details className="filter-dropdown">
          <summary>Тип ({selectedTypes.length || "всі"})</summary>
          <div className="filter-dropdown-body">
            {TASK_TYPE_FILTERS.map((filter) => (
              <label key={filter.value}>
                <input
                  type="checkbox"
                  checked={selectedTypes.includes(filter.value)}
                  onChange={() => toggleType(filter.value)}
                />
                {filter.label}
              </label>
            ))}
          </div>
        </details>
      </div>

      <p className="inbox-meta">
        Відкритих швидких комунікацій: {quickCommunicationOpenCount}
        {quickCommunicationOpenCount >= 3 ? " · рекомендується батчинг" : ""}
      </p>

      {!sessionToken ? <p className="empty-note">Відкрий Інбокс для авторизації сесії.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Завантаження задач...</p> : null}

      {!loading && filteredItems.length === 0 ? <p className="empty-note">Задач за поточним фільтром немає.</p> : null}

      {!loading && filteredItems.length > 0 ? (
        <>
          <section className="today-section">
            <h3>Заплановані</h3>
            <p className="inbox-meta">Показує задачі з планованим стартом, відсортовані за часом.</p>
            {renderTaskGroups(scheduledGroups, "Запланованих задач немає.")}
          </section>

          <section className="today-section">
            <h3>Беклог</h3>
            <p className="inbox-meta">Тут задачі без планованого старту. Дедлайн та оцінка лишаються видимими.</p>
            {renderTaskGroups(backlogGroups, "Беклог порожній.")}
          </section>
        </>
      ) : null}

      <TaskActionModal
        open={!!pendingAction}
        action={pendingAction?.action ?? null}
        taskTitle={pendingAction?.task.title ?? null}
        busy={workingTaskId !== null}
        onCancel={() => setPendingAction(null)}
        onConfirm={(payload) => {
          void confirmAction(payload);
        }}
      />

      <TaskDetailModal
        open={taskModalMode === "create" || !!activeTask}
        initialMode={taskModalMode === "create" ? "create" : "view"}
        task={activeTask}
        projects={projects}
        busy={workingTaskId !== null}
        calendarSyncNotice={activeTask ? calendarNotice : null}
        calendarInboundState={activeTask ? calendarInboundState : null}
        onClose={() => {
          setActiveTask(null);
          setTaskModalMode("view");
        }}
        onSave={(payload) => {
          void saveTask(payload);
        }}
        onDelete={() => {
          void deleteCurrentTask();
        }}
        onAction={(action) => {
          if (!activeTask) return;
          if (action === "done") {
            void runDone(activeTask);
            return;
          }
          setActiveTask(null);
          setTaskModalMode("view");
          setPendingAction({ task: activeTask, action });
        }}
        onCreateCalendarEvent={() => {
          if (!activeTask) return;
          if (!calendarStatus?.connected) {
            setError("Google Calendar не підключено. Відкрий вкладку «Календар» і підключи акаунт.");
            return;
          }
          setPendingCalendarTask(activeTask);
          setCalendarError(null);
        }}
        onRetryCalendarSync={() => {
          if (!activeTask) return;
          void retryCalendarSync(activeTask);
        }}
        onDetachCalendarLink={() => {
          if (!activeTask) return;
          void detachCalendarLink(activeTask);
        }}
        onApplyCalendarInbound={() => {
          if (!activeTask) return;
          void applyInboundCalendarChange(activeTask);
        }}
        onOpenLinkedCalendarEvent={(url) => {
          diagnostics.trackAction("open_task_linked_calendar_event", { taskId: activeTask?.id });
          try {
            if (window.Telegram?.WebApp?.openLink) {
              window.Telegram.WebApp.openLink(url);
              return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
          } catch {
            window.location.href = url;
          }
        }}
      />

      <CalendarEventModal
        open={!!pendingCalendarTask}
        titleHint={pendingCalendarTask?.title ?? ""}
        detailsHint={pendingCalendarTask?.details ?? ""}
        startHint={pendingCalendarTask?.scheduled_for ?? pendingCalendarTask?.due_at ?? new Date().toISOString()}
        endHint={pendingCalendarTask?.due_at ?? null}
        busy={calendarCreating}
        errorMessage={calendarError}
        onCancel={() => {
          if (calendarCreating) return;
          setPendingCalendarTask(null);
          setCalendarError(null);
        }}
        onConfirm={(payload) => {
          void createCalendarFromTask(payload);
        }}
      />
    </section>
  );
}


















