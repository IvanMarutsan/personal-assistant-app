import { DateTime } from "npm:luxon@3.6.1";
import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { planningThresholds } from "../_shared/planning-config.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type TaskRow = {
  id: string;
  title: string;
  task_type:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday";
  status: "planned" | "in_progress" | "blocked" | "done" | "cancelled";
  importance: number;
  commitment_type: "flexible" | "hard";
  is_recurring: boolean;
  is_protected_essential: boolean;
  postpone_count: number;
  due_at: string | null;
  scheduled_for: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

type TaskEventRow = {
  event_type:
    | "created"
    | "triaged_from_inbox"
    | "status_changed"
    | "rescheduled"
    | "postponed"
    | "missed"
    | "completed"
    | "reopened"
    | "task_updated";
  reason_code:
    | "reprioritized"
    | "blocked_dependency"
    | "urgent_interrupt"
    | "calendar_conflict"
    | "underestimated"
    | "low_energy"
    | "waiting_on_external"
    | "waiting_response"
    | "personal_issue"
    | "other"
    | null;
  new_status: "planned" | "in_progress" | "blocked" | "done" | "cancelled" | null;
};

type Recommendation = {
  taskId?: string;
  title: string;
  reason: string;
  tier:
    | "overdue"
    | "hard_today"
    | "protected_essential"
    | "high_importance"
    | "quick_comm_batch";
};

function taskProjectName(task: TaskRow): string | null {
  if (!task.projects) return null;
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? null;
  return task.projects.name ?? null;
}

function taskTime(task: TaskRow, zone: string): DateTime | null {
  const ref = task.scheduled_for ?? task.due_at;
  if (!ref) return null;
  const dt = DateTime.fromISO(ref, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt : null;
}

function isSameDay(dt: DateTime | null, dayStart: DateTime, dayEnd: DateTime): boolean {
  if (!dt) return false;
  return dt >= dayStart && dt <= dayEnd;
}

function isOverdue(task: TaskRow, now: DateTime): boolean {
  if (task.status !== "planned") return false;
  const ref = task.scheduled_for ?? task.due_at;
  if (!ref) return false;
  const dt = DateTime.fromISO(ref, { zone: "utc" }).setZone(now.zoneName);
  return dt.isValid && dt < now;
}

function topTask(
  tasks: TaskRow[],
  zone: string,
  reason: string,
  tier: Recommendation["tier"]
): Recommendation | null {
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => {
    const aDt = taskTime(a, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    const bDt = taskTime(b, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    if (aDt !== bDt) return aDt - bDt;
    return b.importance - a.importance;
  });

  const selected = sorted[0];
  if (!selected) return null;

  return {
    taskId: selected.id,
    title: selected.title,
    reason,
    tier
  };
}

function uniqRecommendations(items: Array<Recommendation | null>): Recommendation[] {
  const result: Recommendation[] = [];
  const seenTaskIds = new Set<string>();

  for (const item of items) {
    if (!item) continue;

    if (item.taskId) {
      if (seenTaskIds.has(item.taskId)) continue;
      seenTaskIds.add(item.taskId);
    }

    result.push(item);
  }

  return result;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const sessionUser = await resolveSessionUser(req);
  if (!sessionUser) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  const timezone = (profile?.timezone as string | undefined) || "UTC";
  const now = DateTime.now().setZone(timezone);
  const dayStart = now.startOf("day");
  const dayEnd = now.endOf("day");

  const { data: tasksData, error: tasksError } = await supabase
    .from("tasks")
    .select(
      "id, title, task_type, status, importance, commitment_type, is_recurring, is_protected_essential, postpone_count, due_at, scheduled_for, projects(name)"
    )
    .eq("user_id", sessionUser.userId)
    .neq("status", "cancelled")
    .limit(500);

  if (tasksError) {
    return jsonResponse({ ok: false, error: "tasks_fetch_failed" }, 500);
  }

  const tasks = (tasksData ?? []) as TaskRow[];

  const { data: eventsData, error: eventsError } = await supabase
    .from("task_events")
    .select("event_type, reason_code, new_status")
    .eq("user_id", sessionUser.userId)
    .gte("created_at", dayStart.toUTC().toISO())
    .lte("created_at", dayEnd.toUTC().toISO())
    .limit(1000);

  if (eventsError) {
    return jsonResponse({ ok: false, error: "events_fetch_failed" }, 500);
  }

  const events = (eventsData ?? []) as TaskEventRow[];

  const activeTasks = tasks.filter((task) => task.status !== "done");
  const actionableTasks = activeTasks.filter(
    (task) => task.status === "planned" || task.status === "in_progress"
  );

  const overduePlanned = actionableTasks.filter((task) => isOverdue(task, now));
  const hardToday = actionableTasks.filter(
    (task) =>
      task.commitment_type === "hard" &&
      (task.status === "planned" || task.status === "in_progress") &&
      isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  );
  const protectedPending = actionableTasks.filter(
    (task) => task.is_protected_essential && task.status !== "done"
  );
  const highImportanceToday = actionableTasks.filter(
    (task) =>
      task.importance >= planningThresholds.highImportanceMin &&
      task.status === "planned" &&
      isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  );

  const quickCommunicationOpen = actionableTasks.filter(
    (task) =>
      task.task_type === "quick_communication" &&
      (task.status === "planned" || task.status === "in_progress")
  );

  const quickBatchRecommendation: Recommendation | null =
    quickCommunicationOpen.length >= planningThresholds.quickCommunicationBatching
      ? {
          title: `Batch quick communication tasks (${quickCommunicationOpen.length})`,
          reason: "Several communication tasks are open; batching reduces context switching.",
          tier: "quick_comm_batch"
        }
      : null;

  const tiered = uniqRecommendations([
    topTask(overduePlanned, timezone, "Overdue planned task should be pulled forward first.", "overdue"),
    topTask(hardToday, timezone, "Hard commitment scheduled today needs protection.", "hard_today"),
    topTask(
      protectedPending,
      timezone,
      "Protected essential is still pending and should not be squeezed out.",
      "protected_essential"
    ),
    topTask(
      highImportanceToday,
      timezone,
      "High-importance task is planned for today.",
      "high_importance"
    ),
    quickBatchRecommendation
  ]);

  const primaryRecommendation = tiered[0] ?? null;
  const secondaryRecommendations = tiered.slice(1, 3);

  const plannedTodayCount = activeTasks.filter(
    (task) => task.status === "planned" && isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  ).length;

  const protectedScheduledTodayCount = protectedPending.filter((task) =>
    isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  ).length;

  const overloadFlags: Array<{ code: string; message: string }> = [];
  if (plannedTodayCount > planningThresholds.plannedTodayOverload) {
    overloadFlags.push({ code: "too_many_planned_today", message: "Too many tasks are planned for today." });
  }
  if (overduePlanned.length > planningThresholds.overdueOverload) {
    overloadFlags.push({ code: "too_many_overdue", message: "Overdue planned tasks are accumulating." });
  }
  if (protectedPending.length > 0 && protectedScheduledTodayCount === 0) {
    overloadFlags.push({
      code: "protected_essentials_missing_today",
      message: "Protected essentials are pending but not represented in today execution."
    });
  }
  if (quickCommunicationOpen.length >= planningThresholds.quickCommunicationOverload) {
    overloadFlags.push({
      code: "excessive_quick_communication",
      message: "Quick communication load is high; batching is recommended."
    });
  }

  const protectedEssentialRisk = activeTasks
    .filter(
      (task) =>
        task.is_protected_essential &&
        (task.postpone_count ?? 0) >= planningThresholds.protectedRiskPostponeCount
    )
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      project: taskProjectName(task),
      postponeCount: task.postpone_count,
      reason: "Protected essential postponed repeatedly."
    }));

  const recurringEssentialRisk = activeTasks
    .filter(
      (task) =>
        (task.task_type === "recurring_essential" || task.is_recurring) &&
        (task.postpone_count ?? 0) >= planningThresholds.recurringRiskPostponeCount
    )
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      project: taskProjectName(task),
      postponeCount: task.postpone_count,
      reason: "Recurring essential repeatedly not completed."
    }));

  const squeezedOutRisk = activeTasks
    .filter(
      (task) =>
        (task.is_protected_essential || task.task_type === "recurring_essential") &&
        (task.postpone_count ?? 0) >= planningThresholds.squeezedOutPostponeCount
    )
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      project: taskProjectName(task),
      postponeCount: task.postpone_count,
      reason: "Task appears consistently squeezed out."
    }));

  const completedTodayCount = events.filter((event) => event.event_type === "completed").length;
  const movedTodayEvents = events.filter(
    (event) => event.event_type === "postponed" || event.event_type === "rescheduled"
  );
  const movedTodayCount = movedTodayEvents.length;
  const cancelledTodayCount = events.filter(
    (event) => event.event_type === "status_changed" && event.new_status === "cancelled"
  ).length;

  const protectedEssentialsMissedToday = protectedPending.filter((task) =>
    isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  ).length;

  const reasonCounts = movedTodayEvents.reduce<Record<string, number>>((acc, event) => {
    const key = event.reason_code ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const topMovedReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  return jsonResponse({
    ok: true,
    generatedAt: DateTime.utc().toISO(),
    timezone,
    rulesVersion: "v1-deterministic",
    whatNow: {
      primary: primaryRecommendation,
      secondary: secondaryRecommendations
    },
    overload: {
      hasOverload: overloadFlags.length > 0,
      plannedTodayCount,
      overduePlannedCount: overduePlanned.length,
      quickCommunicationOpenCount: quickCommunicationOpen.length,
      quickCommunicationBatchingRecommended:
        quickCommunicationOpen.length >= planningThresholds.quickCommunicationBatching,
      protectedPendingCount: protectedPending.length,
      flags: overloadFlags
    },
    essentialRisk: {
      protectedEssentialRisk,
      recurringEssentialRisk,
      squeezedOutRisk
    },
    dailyReview: {
      completedTodayCount,
      movedTodayCount,
      cancelledTodayCount,
      protectedEssentialsMissedToday,
      topMovedReasons
    },
    appliedThresholds: planningThresholds
  });
});
