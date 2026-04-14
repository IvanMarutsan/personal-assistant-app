import { useEffect, useMemo, useState } from "react";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { TaskActionModal } from "../../components/TaskActionModal";
import { TaskDetailModal } from "../../components/TaskDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  applyTaskCalendarInbound,
  applyTaskGoogleInbound,
  createGoogleCalendarEvent,
  createTask,
  deleteTask,
  detachTaskCalendarLink as detachTaskCalendarLinkRequest,
  detachTaskGoogleLink as detachTaskGoogleLinkRequest,
  getGoogleCalendarStatus,
  inspectTaskCalendarInbound,
  inspectTaskGoogleInbound,
  keepTaskCalendarLocalVersion,
  retryTaskCalendarSync as retryTaskCalendarSyncRequest,
  retryTaskGoogleSync as retryTaskGoogleSyncRequest,
  startGoogleCalendarConnect,
  getProjects,
  getTasks,
  updateTask,
  updateTaskStatus
} from "../../lib/api";
import { moveReasonLabel } from "../../lib/reasons";
import { recurrenceLabel } from "../../lib/recurrence";
import { formatTaskTimingTone, isBacklogTask, parseTaskDate, planningFlexibilityLabel } from "../../lib/taskTiming";
import { isCommunicationTaskType, TASK_TYPE_FILTER_OPTIONS, taskTypeLabel } from "../../lib/taskTypes";
import type { GoogleCalendarStatus, MoveReasonCode, ProjectItem, TaskCalendarInboundState, TaskGoogleInboundState, TaskItem, TaskType } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";
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

function oauthReasonLabel(reason: string | null): string {
  if (!reason) return "Google успішно підключено.";
  if (reason === "invalid_or_expired_state") return "Спроба підключення застаріла. Запусти її ще раз.";
  if (reason === "missing_code_or_state") return "Google не повернув потрібні дані для підключення.";
  if (reason === "google_oauth_callback_failed") return "Не вдалося завершити підключення Google.";
  if (reason.startsWith("oauth_")) return "Google повернув помилку під час підключення.";
  return "Підключення Google не вдалося.";
}

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
    .sort(([a, aTasks], [b, bTasks]) => {
      if (a === "Без проєкту" && b !== "Без проєкту") return 1;
      if (b === "Без проєкту" && a !== "Без проєкту") return -1;
      if (aTasks.length != bTasks.length) return bTasks.length - aTasks.length;
      return a.localeCompare(b, "uk-UA");
    })
    .map(([project, projectTasks]) => ({ project, tasks: projectTasks }));
}

function taskCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "задача";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "задачі";
  return "задач";
}

function scheduledBucketMetaLabel(input: { key: string; count: number }): string {
  if (input.key === "overdue") return "Тут те, що вже мало початися раніше і потребує окремого рішення.";
  if (input.key === "today") return "Головна робоча черга: задачі, які вже можна або потрібно рухати.";
  if (input.key === "upcoming") return "Наступні дати, щоб бачити ближчий порядок і не губити пріоритет.";
  return `${input.count} ${taskCountLabel(input.count)}`;
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
  const [googleTaskNotice, setGoogleTaskNotice] = useState<CalendarNotice | null>(null);
  const [googleTaskInboundState, setGoogleTaskInboundState] = useState<TaskGoogleInboundState | null>(null);
  const [pageNotice, setPageNotice] = useState<CalendarNotice | null>(null);
  const diagnostics = useDiagnostics();

  const sessionToken = localStorage.getItem(SESSION_KEY) ?? "";
  const connectHint = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const marker = params.get("calendar_connect");
    const reason = params.get("reason");
    if (marker === "success") return { tone: "success" as const, message: "Google перепідключено. Оновлюю стан Tasks..." };
    if (marker === "error") return { tone: "error" as const, message: oauthReasonLabel(reason) };
    return null;
  }, []);

  async function loadTasks(): Promise<TaskItem[]> {
    if (!sessionToken) {
      setItems([]);
      return [];
    }

    setLoading(true);
    setError(null);
    diagnostics.trackAction("load_tasks", { route: "/tasks" });

    try {
      const tasks = await getTasks(sessionToken);
      setItems(tasks);
      diagnostics.markRefresh();
      diagnostics.setScreenDataSource("tasks_data");
      return tasks;
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
      return [];
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
      return null;
    }
    try {
      const status = await getGoogleCalendarStatus(sessionToken);
      setCalendarStatus(status);
      return status;
    } catch {
      setCalendarStatus(null);
      return null;
    }
  }

  useEffect(() => {
    void Promise.all([loadTasks(), loadProjects(), loadCalendarStatus()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!connectHint) return;
    if (connectHint.tone === "success" && sessionToken) {
      void (async () => {
        const [, status] = await Promise.all([loadTasks(), loadCalendarStatus()]);
        setPageNotice(
          status?.tasksScopeAvailable
            ? { tone: "success", message: "Google перепідключено. Google Tasks уже доступні." }
            : { tone: "info", message: "Google перепідключено, але Google Tasks досі недоступні для цього акаунта." }
        );
      })();
    } else {
      setPageNotice(connectHint);
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("calendar_connect");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectHint, sessionToken]);
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

  useEffect(() => {
    if (!sessionToken || !activeTask || activeTask.google_task_sync_mode !== "app_managed" || !activeTask.google_task_id) {
      setGoogleTaskInboundState(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await inspectTaskGoogleInbound({ sessionToken, taskId: activeTask.id });
        if (!cancelled) setGoogleTaskInboundState(state);
      } catch {
        if (!cancelled) setGoogleTaskInboundState(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTask?.id, activeTask?.google_task_id, activeTask?.google_task_sync_mode, sessionToken]);

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

  const scheduledBuckets = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const overdue: TaskItem[] = [];
    const todayItems: TaskItem[] = [];
    const upcoming: TaskItem[] = [];

    for (const task of scheduledItems) {
      const scheduledAt = parseTaskDate(task.scheduled_for);
      const timestamp = scheduledAt?.getTime();
      if (!timestamp || Number.isNaN(timestamp)) {
        upcoming.push(task);
        continue;
      }
      if (timestamp < today.getTime()) {
        overdue.push(task);
        continue;
      }
      if (timestamp < tomorrow.getTime()) {
        todayItems.push(task);
        continue;
      }
      upcoming.push(task);
    }

    return [
      { key: "overdue", label: "Прострочене в плані", tasks: overdue },
      { key: "today", label: "Найближче до виконання", tasks: todayItems },
      { key: "upcoming", label: "Далі за часом", tasks: upcoming }
    ].filter((bucket) => bucket.tasks.length > 0);
  }, [scheduledItems]);

  const backlogGroups = useMemo(() => groupByProject(backlogItems), [backlogItems]);

  const quickCommunicationOpenCount = useMemo(
    () =>
      items.filter(
        (task) =>
          isCommunicationTaskType(task.task_type) &&
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
    const googleTaskWarning = activeTask.linked_google_task
      ? activeTask.google_task_sync_mode === "app_managed"
        ? " Зв'язану задачу в Google Tasks теж буде видалено."
        : " Зв'язок з Google Tasks буде прибрано лише локально."
      : "";
    const recurrenceWarning = activeTask.recurrence_rule ? " Це видалить лише цей повтор." : "";
    const confirmed = window.confirm(`Видалити задачу "${activeTask.title}"?${recurrenceWarning}${calendarWarning}${googleTaskWarning}`);
    if (!confirmed) return;

    setWorkingTaskId(activeTask.id);
    setError(null);
    diagnostics.trackAction("delete_task", { taskId: activeTask.id });

    try {
      await deleteTask({ sessionToken, taskId: activeTask.id });
      setActiveTask(null);
      setTaskModalMode("view");
      setCalendarNotice(null);
      setGoogleTaskNotice(null);
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
    recurrenceFrequency: "daily" | "weekly" | "monthly" | null;
  }) {
    if (!sessionToken) return;

    const isCreate = taskModalMode === "create";
    setWorkingTaskId(payload.taskId ?? "create_task");
    setError(null);
    diagnostics.trackAction(isCreate ? "create_task_manual" : "update_task_fields", {
      taskId: payload.taskId ?? null
    });

    try {
      let createdTaskId: string | null = null;
      let createdGoogleTaskSyncError: string | null = null;
      let createdLinkedGoogleTask = false;

      if (isCreate) {
        const created = await createTask({
          sessionToken,
          title: payload.title,
          details: payload.details,
          projectId: payload.projectId,
          taskType: payload.taskType,
          dueAt: payload.dueAt,
          scheduledFor: payload.scheduledFor,
          estimatedMinutes: payload.estimatedMinutes,
          planningFlexibility: payload.planningFlexibility,
          recurrenceFrequency: payload.recurrenceFrequency
        });
        createdTaskId = created.taskId;
        createdGoogleTaskSyncError = created.googleTaskSyncError;
        createdLinkedGoogleTask = created.linkedGoogleTask;
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
          planningFlexibility: payload.planningFlexibility,
          recurrenceFrequency: payload.recurrenceFrequency
        });
      }

      const tasks = await loadTasks();
      const createdTask = createdTaskId ? tasks.find((task) => task.id === createdTaskId) ?? null : null;

      if (isCreate && createdTask) {
        setActiveTask(createdTask);
        setTaskModalMode("view");
      } else {
        setActiveTask(null);
        setTaskModalMode("view");
      }

        if (isCreate) {
          if (createdGoogleTaskSyncError) {
            setPageNotice({
              tone: "info",
              message:
                createdGoogleTaskSyncError === "google_tasks_scope_missing"
                  ? "Задачу створено в додатку, але Google Tasks ще недоступні для цього підключення. Перепідключи Google у вкладці «Календар»."
                  : createdGoogleTaskSyncError === "google_tasks_permission_denied"
                    ? "Задачу створено в додатку, але Google Tasks зараз не дає доступ. Перепідключи Google і перевір дозволи для Tasks."
                  : "Задачу створено в додатку, але синхронізація з Google Tasks зараз недоступна."
            });
        } else if (createdLinkedGoogleTask) {
          setPageNotice({ tone: "success", message: "Задачу створено в додатку і синхронізовано з Google Tasks." });
        } else {
          setPageNotice({ tone: "success", message: "Задачу створено в додатку." });
        }
      }
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
      setError("Спочатку авторизуйся в Інбоксі.");
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

  async function retryGoogleTaskSync(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("retry_task_google_sync", { taskId: task.id });

    try {
      await retryTaskGoogleSyncRequest({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: task.linked_google_task || task.google_task_id ? "Синхронізацію з Google Tasks оновлено." : "Задачу створено в Google Tasks."
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
      setError(retryError instanceof Error ? retryError.message : "Не вдалося синхронізувати задачу з Google Tasks");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function applyInboundGoogleTaskChange(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("apply_task_google_inbound", { taskId: task.id });

    try {
      const state = await applyTaskGoogleInbound({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: state.message ?? "Зміни з Google Tasks застосовано."
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
      setGoogleTaskNotice({ tone: "error", message: "Не вдалося застосувати зміни з Google Tasks." });
      setError(applyError instanceof Error ? applyError.message : "Не вдалося застосувати зміни з Google Tasks.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function detachGoogleTaskLink(task: TaskItem) {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    setWorkingTaskId(task.id);
    setError(null);
    diagnostics.trackAction("detach_task_google_link", { taskId: task.id });

    try {
      await detachTaskGoogleLinkRequest({ sessionToken, taskId: task.id });
      setGoogleTaskNotice({
        tone: "success",
        message: task.google_task_sync_mode === "app_managed" ? "Зв'язок із Google Tasks прибрано." : "Google Tasks від'єднано від задачі."
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
      setGoogleTaskNotice({ tone: "error", message: "Не вдалося від'єднати Google Tasks." });
      setError(detachError instanceof Error ? detachError.message : "Не вдалося від'єднати Google Tasks.");
    } finally {
      setWorkingTaskId(null);
    }
  }

  async function reconnectGoogleForTasks() {
    if (!sessionToken) {
      setError("Спочатку авторизуйся в Інбоксі.");
      return;
    }

    try {
      const result = await startGoogleCalendarConnect({ sessionToken, returnPath: "/tasks" });
      if (window.Telegram?.WebApp?.openLink) {
        window.Telegram.WebApp.openLink(result.authUrl);
        return;
      }
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    } catch (connectError) {
      if (connectError instanceof ApiError) {
        diagnostics.trackFailure({
          path: connectError.path,
          status: connectError.status,
          code: connectError.code,
          message: connectError.message,
          details: connectError.details
        });
      }
      setError(connectError instanceof Error ? connectError.message : "Не вдалося почати перепідключення Google.");
    }
  }

  function openCreateTask() {
    setTaskModalMode("create");
    setActiveTask(null);
    setCalendarNotice(null);
    setGoogleTaskNotice(null);
    setPageNotice(null);
    setError(null);
  }

  function renderTaskRow(task: TaskItem, scope: "scheduled" | "backlog") {
    const timing = formatTaskTimingTone(task);
    const project = projectName(task);
    const calendarHint = calendarLinkHint(task) ?? (task.linked_calendar_event ? "Подія в Google Calendar" : null);

    return (
      <li key={task.id} className={scope === "scheduled" ? "inbox-item task-card task-card--scheduled" : "inbox-item task-card task-card--backlog"}>
        <div className="task-card__main">
          <p className="inbox-main-text task-card-title">
            {task.title}
            {task.recurrence_rule ? <span className="recurrence-badge">{recurrenceLabel(task.recurrence_rule)}</span> : null}
            {task.is_protected_essential ? <span className="essential-badge">Важлива задача</span> : null}
            {task.planning_flexibility ? <span className={`planning-badge planning-badge--${task.planning_flexibility}`}>{planningFlexibilityLabel(task.planning_flexibility)}</span> : null}
          </p>
          <p className={timing.tone === "warn" ? "error-note task-card__timing" : "inbox-meta task-card__timing"}>{timing.label}</p>
          <div className="task-chip-row task-chip-row--secondary">
            <span className="task-chip task-chip--type">{taskTypeLabel(task.task_type)}</span>
            <span className="task-chip">{statusLabel(task.status)}</span>
            {scope === "backlog" ? <span className="task-chip task-chip--backlog">Беклог</span> : <span className="task-chip task-chip--scheduled">Заплановано</span>}
          </div>
          <div className="task-card__meta-stack">
            <p className="inbox-meta">Проєкт: {project}</p>
            {task.status === "cancelled" ? (
              <p className="inbox-meta">
                Причина: {moveReasonLabel(task.last_moved_reason) ?? "не вказана"}
                {task.cancel_reason_text ? ` / ${task.cancel_reason_text}` : ""}
              </p>
            ) : null}
            {task.recurrence_rule ? <p className="inbox-meta">Це повторювана задача. Дії тут стосуються лише цього повтору.</p> : null}
            {calendarHint ? <p className="inbox-meta task-card__calendar">{calendarHint}</p> : null}
          </div>
        </div>
        <div className="inbox-actions task-card__actions">
          <button
            type="button"
            onClick={() => {
              setTaskModalMode("view");
              setActiveTask(task);
            }}
          >
            Відкрити
          </button>
          {task.status !== "done" ? (
            <button className="ghost" onClick={() => void runDone(task)} disabled={workingTaskId === task.id}>
              Виконано
            </button>
          ) : null}
        </div>
      </li>
    );
  }

  function renderScheduledQueue() {
    if (scheduledBuckets.length === 0) {
      return <p className="empty-note">Запланованих задач немає.</p>;
    }

    return scheduledBuckets.map((bucket) => (
      <div key={bucket.key} className="task-queue-group">
        <div className="task-queue-group__header">
          <strong>{bucket.label}</strong>
          <span className="project-group-meta">{bucket.tasks.length} {taskCountLabel(bucket.tasks.length)}</span>
        </div>
        <p className="inbox-meta">{scheduledBucketMetaLabel({ key: bucket.key, count: bucket.tasks.length })}</p>
        <ul className="inbox-list">
          {bucket.tasks.map((task) => renderTaskRow(task, "scheduled"))}
        </ul>
      </div>
    ));
  }

  function renderBacklogGroups() {
    if (backlogGroups.length === 0) {
      return <p className="empty-note">Беклог порожній.</p>;
    }

    return backlogGroups.map(({ project, tasks }) => (
      <details key={project} className="project-group backlog-group">
        <summary>
          <span className="project-group-title">{project}</span>
          <span className="project-group-meta">{tasks.length} {taskCountLabel(tasks.length)}</span>
        </summary>
        <ul className="inbox-list">
          {tasks.map((task) => renderTaskRow(task, "backlog"))}
        </ul>
      </details>
    ));
  }

  return (
    <section className="panel">
      <h2>Задачі</h2>
      <p>Сторінка задач тепер показує робочий порядок: спочатку заплановане й датоване, а беклог лишається нижче як secondary queue.</p>

      <div className="toolbar-row">
        <button type="button" onClick={openCreateTask} disabled={!sessionToken || loading || workingTaskId !== null}>
          Створити задачу
        </button>
      </div>

      {pageNotice ? <p className={pageNotice.tone === "error" ? "error-note" : "inbox-meta"}>{pageNotice.message}</p> : null}

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
            {TASK_TYPE_FILTER_OPTIONS.map((filter) => (
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
            <h3>Операційна черга</h3>
            <p className="inbox-meta">Тут усе, що вже має час або дату і повинно відчуватись як найближча робота, а не як список проєктів.</p>
            {renderScheduledQueue()}
          </section>

          <section className="today-section">
            <details className="project-group backlog-shell">
              <summary>
                <span className="project-group-title">Беклог</span>
                <span className="project-group-meta">{backlogItems.length} {taskCountLabel(backlogItems.length)}</span>
              </summary>
              <p className="inbox-meta">Тут лишаються задачі без планованого старту. Проєкт видно, але він більше не визначає головну структуру всієї сторінки.</p>
              {renderBacklogGroups()}
            </details>
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
        googleTaskSyncNotice={activeTask ? googleTaskNotice : null}
        googleTaskInboundState={activeTask ? googleTaskInboundState : null}
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
        onRetryGoogleTaskSync={() => {
          if (!activeTask) return;
          void retryGoogleTaskSync(activeTask);
        }}
        onDetachGoogleTaskLink={() => {
          if (!activeTask) return;
          void detachGoogleTaskLink(activeTask);
        }}
        onApplyGoogleTaskInbound={() => {
          if (!activeTask) return;
          void applyInboundGoogleTaskChange(activeTask);
        }}
        onReconnectGoogle={() => {
          void reconnectGoogleForTasks();
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





















