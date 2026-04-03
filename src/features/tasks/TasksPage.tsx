import { useEffect, useMemo, useState } from "react";
import { TaskActionModal } from "../../components/TaskActionModal";
import { useDiagnostics } from "../../lib/diagnostics";
import { ApiError, getTasks, updateTaskStatus } from "../../lib/api";
import type { MoveReasonCode, TaskItem, TaskType } from "../../types/api";

const SESSION_KEY = "personal_assistant_app_session_token";
const TASK_TYPE_FILTERS: Array<{ label: string; value: "all" | TaskType }> = [
  { label: "All types", value: "all" },
  { label: "Deep work", value: "deep_work" },
  { label: "Quick communication", value: "quick_communication" },
  { label: "Admin/operational", value: "admin_operational" },
  { label: "Recurring essential", value: "recurring_essential" },
  { label: "Personal essential", value: "personal_essential" },
  { label: "Someday", value: "someday" }
];

type TaskActionKind = "postpone" | "reschedule" | "block" | "cancel";

type PendingAction = {
  task: TaskItem;
  action: TaskActionKind;
};

function projectName(task: TaskItem): string {
  if (!task.projects) return "No project";
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? "No project";
  return task.projects.name ?? "No project";
}

export function TasksPage() {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workingTaskId, setWorkingTaskId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | TaskType>("all");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
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
      setError(loadError instanceof Error ? loadError.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredItems = useMemo(
    () => items.filter((task) => (typeFilter === "all" ? true : task.task_type === typeFilter)),
    [items, typeFilter]
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
      setError("Authenticate in Inbox first.");
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
      setError(actionError instanceof Error ? actionError.message : "Task update failed");
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

      if (pendingAction.action === "cancel") {
        await updateTaskStatus({
          ...common,
          status: "cancelled"
        });
      }

      setPendingAction(null);
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
      setError(actionError instanceof Error ? actionError.message : "Task update failed");
    } finally {
      setWorkingTaskId(null);
    }
  }

  return (
    <section className="panel">
      <h2>Tasks</h2>
      <p>Grouped by project with task type visibility and basic execution actions.</p>

      <div className="toolbar-row">
        <label>
          Type filter:
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | TaskType)}>
            {TASK_TYPE_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="inbox-meta">
        Quick communication open: {quickCommunicationOpenCount}
        {quickCommunicationOpenCount >= 3 ? " · batching recommended" : ""}
      </p>

      {!sessionToken ? <p className="empty-note">Open Inbox first to authenticate session.</p> : null}
      {error ? <p className="error-note">{error}</p> : null}
      {loading ? <p>Loading tasks...</p> : null}

      {!loading && filteredItems.length === 0 ? <p className="empty-note">No active tasks.</p> : null}

      {Object.entries(groupedByProject).map(([project, tasks]) => (
        <section key={project} className="project-group">
          <h3>{project}</h3>
          <ul className="inbox-list">
            {tasks.map((task) => (
              <li key={task.id} className="inbox-item">
                <p className="inbox-main-text">
                  {task.title}
                  {task.is_protected_essential ? <span className="essential-badge">Protected essential</span> : null}
                </p>
                <p className="inbox-meta">
                  {task.task_type} · {task.status}
                </p>
                <div className="inbox-actions">
                  <button onClick={() => void runDone(task)} disabled={workingTaskId === task.id}>
                    Done
                  </button>
                  <button
                    onClick={() => setPendingAction({ task, action: "postpone" })}
                    disabled={workingTaskId === task.id}
                  >
                    Postpone
                  </button>
                  <button
                    onClick={() => setPendingAction({ task, action: "reschedule" })}
                    disabled={workingTaskId === task.id}
                  >
                    Reschedule
                  </button>
                  <button
                    onClick={() => setPendingAction({ task, action: "block" })}
                    disabled={workingTaskId === task.id}
                  >
                    Block
                  </button>
                  <button
                    className="danger"
                    onClick={() => setPendingAction({ task, action: "cancel" })}
                    disabled={workingTaskId === task.id}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <TaskActionModal
        open={Boolean(pendingAction)}
        action={pendingAction?.action ?? null}
        taskTitle={pendingAction?.task.title ?? null}
        busy={Boolean(workingTaskId)}
        onCancel={() => setPendingAction(null)}
        onConfirm={(payload) => {
          void confirmAction(payload);
        }}
      />
    </section>
  );
}
