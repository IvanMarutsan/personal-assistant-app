import { useEffect, useMemo, useState } from "react";
import { CalendarEventModal } from "../../components/CalendarEventModal";
import { TaskActionModal } from "../../components/TaskActionModal";
import { TaskDetailModal } from "../../components/TaskDetailModal";
import { useDiagnostics } from "../../lib/diagnostics";
import {
  ApiError,
  createGoogleCalendarEvent,
  getGoogleCalendarStatus,
  getProjects,
  getTasks,
  updateTask,
  updateTaskStatus
} from "../../lib/api";
import { moveReasonLabel } from "../../lib/reasons";
import type { GoogleCalendarStatus, MoveReasonCode, ProjectItem, TaskItem, TaskType } from "../../types/api";

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

type PendingAction = {
  task: TaskItem;
  action: TaskActionKind;
};

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

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalDateTime(value: Date): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(value);
}

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function timingLine(task: TaskItem): { label: string; tone: "neutral" | "warn" | "ok" } {
  const scheduled = parseDate(task.scheduled_for);
  const due = parseDate(task.due_at);
  const now = new Date();

  if (!scheduled && !due) {
    return { label: "Без часу", tone: "neutral" };
  }

  const fragments: string[] = [];
  if (scheduled) {
    fragments.push(`Заплановано: ${formatLocalDateTime(scheduled)}`);
  }
  if (due) {
    fragments.push(`Дедлайн: ${formatLocalDateTime(due)}`);
  }

  const reference = scheduled ?? due;
  if (!reference) {
    return { label: fragments.join(" · "), tone: "neutral" };
  }

  if (task.status !== "done" && task.status !== "cancelled" && reference < now) {
    return { label: `${fragments.join(" · ")} · Прострочено`, tone: "warn" };
  }
  if (isToday(reference)) {
    return { label: `${fragments.join(" · ")} · Сьогодні`, tone: "ok" };
  }
  return { label: `${fragments.join(" · ")} · Майбутнє`, tone: "neutral" };
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

export function TasksPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workingTaskId, setWorkingTaskId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<TaskType[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<TaskStatusScope[]>(["active"]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [activeTask, setActiveTask] = useState<TaskItem | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null);
  const [pendingCalendarTask, setPendingCalendarTask] = useState<TaskItem | null>(null);
  const [calendarCreating, setCalendarCreating] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
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
        timezone: payload.timezone
      });
      setPendingCalendarTask(null);
      setActiveTask(null);
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

  const groupedByProject = useMemo(() => {
    return filteredItems.reduce<Record<string, TaskItem[]>>((acc, task) => {
      const key = projectName(task);
      if (!acc[key]) acc[key] = [];
      acc[key].push(task);
      return acc;
    }, {});
  }, [filteredItems]);

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

  return (
    <section className="panel">
      <h2>Задачі</h2>
      <p>Список задач по проєктах з фільтрами та базовими діями виконання.</p>

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

      {!loading && filteredItems.length === 0 ? (
        <p className="empty-note">Задач за поточним фільтром немає.</p>
      ) : null}

      {Object.entries(groupedByProject).map(([project, tasks]) => (
        <section key={project} className="project-group">
          <h3>{project}</h3>
          <ul className="inbox-list">
            {tasks.map((task) => {
              const timing = timingLine(task);
              return (
                <li key={task.id} className="inbox-item">
                  <p className="inbox-main-text">
                    {task.title}
                    {task.is_protected_essential ? <span className="essential-badge">Захищене важливе</span> : null}
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
                  <div className="inbox-actions">
                    {task.status !== "done" ? (
                      <button onClick={() => void runDone(task)} disabled={workingTaskId === task.id}>
                        Виконано
                      </button>
                    ) : null}
                    <button type="button" className="ghost" onClick={() => setActiveTask(task)}>
                      Деталі
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

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
        open={!!activeTask}
        task={activeTask}
        projects={projects}
        busy={workingTaskId !== null}
        onClose={() => setActiveTask(null)}
        onSave={(payload) => {
          void (async () => {
            if (!sessionToken) return;
            setWorkingTaskId(payload.taskId);
            setError(null);
            diagnostics.trackAction("update_task_fields", { taskId: payload.taskId });
            try {
              await updateTask({
                sessionToken,
                taskId: payload.taskId,
                title: payload.title,
                details: payload.details,
                projectId: payload.projectId,
                taskType: payload.taskType,
                dueAt: payload.dueAt,
                scheduledFor: payload.scheduledFor
              });

              setActiveTask(null);
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
              setError(saveError instanceof Error ? saveError.message : "Не вдалося зберегти зміни задачі");
            } finally {
              setWorkingTaskId(null);
            }
          })();
        }}
        onAction={(action) => {
          if (!activeTask) return;
          if (action === "done") {
            void runDone(activeTask);
            return;
          }
          setActiveTask(null);
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
