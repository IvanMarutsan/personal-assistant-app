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
  estimated_minutes: number | null;
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
    | "due_today_unscheduled"
    | "protected_essential"
    | "high_importance"
    | "quick_comm_batch";
};

function taskProjectName(task: TaskRow): string | null {
  if (!task.projects) return null;
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? null;
  return task.projects.name ?? null;
}

function taskScheduledTime(task: TaskRow, zone: string): DateTime | null {
  if (!task.scheduled_for) return null;
  const dt = DateTime.fromISO(task.scheduled_for, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt : null;
}

function taskDueTime(task: TaskRow, zone: string): DateTime | null {
  if (!task.due_at) return null;
  const dt = DateTime.fromISO(task.due_at, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt : null;
}

function taskReferenceTime(task: TaskRow, zone: string): DateTime | null {
  return taskScheduledTime(task, zone) ?? taskDueTime(task, zone);
}

function isSameDay(dt: DateTime | null, dayStart: DateTime, dayEnd: DateTime): boolean {
  if (!dt) return false;
  return dt >= dayStart && dt <= dayEnd;
}

function isScheduledForDay(task: TaskRow, zone: string, dayStart: DateTime, dayEnd: DateTime): boolean {
  return isSameDay(taskScheduledTime(task, zone), dayStart, dayEnd);
}

function isDueOnDay(task: TaskRow, zone: string, dayStart: DateTime, dayEnd: DateTime): boolean {
  return isSameDay(taskDueTime(task, zone), dayStart, dayEnd);
}

function isBacklogTask(task: TaskRow): boolean {
  return !task.scheduled_for;
}

function isScheduledOverdue(task: TaskRow, now: DateTime): boolean {
  if (task.status !== "planned") return false;
  const scheduled = taskScheduledTime(task, now.zoneName);
  return !!scheduled && scheduled < now;
}

function sumKnownEstimateMinutes(tasks: TaskRow[]): number {
  return tasks.reduce((sum, task) => sum + (task.estimated_minutes ?? 0), 0);
}

function countMissingEstimates(tasks: TaskRow[]): number {
  return tasks.filter((task) => task.estimated_minutes == null).length;
}

function topTask(
  tasks: TaskRow[],
  zone: string,
  reason: string,
  tier: Recommendation["tier"]
): Recommendation | null {
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => {
    const aDt = taskReferenceTime(a, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    const bDt = taskReferenceTime(b, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
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
      "id, title, task_type, status, importance, commitment_type, is_recurring, is_protected_essential, postpone_count, due_at, scheduled_for, estimated_minutes, projects(name)"
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

  const scheduledToday = actionableTasks.filter((task) =>
    isScheduledForDay(task, timezone, dayStart, dayEnd)
  );
  const overduePlanned = actionableTasks.filter((task) => isScheduledOverdue(task, now));
  const dueTodayWithoutPlannedStart = actionableTasks.filter(
    (task) => isBacklogTask(task) && isDueOnDay(task, timezone, dayStart, dayEnd)
  );
  const hardToday = scheduledToday.filter((task) => task.commitment_type === "hard");
  const protectedPending = actionableTasks.filter((task) => task.is_protected_essential);
  const highImportanceToday = scheduledToday.filter(
    (task) => task.importance >= planningThresholds.highImportanceMin && task.status === "planned"
  );
  const backlogCount = actionableTasks.filter((task) => isBacklogTask(task)).length;
  const scheduledKnownEstimateMinutes = sumKnownEstimateMinutes(scheduledToday);
  const scheduledMissingEstimateCount = countMissingEstimates(scheduledToday);

  const quickCommunicationOpen = actionableTasks.filter(
    (task) => task.task_type === "quick_communication"
  );

  const quickBatchRecommendation: Recommendation | null =
    quickCommunicationOpen.length >= planningThresholds.quickCommunicationBatching
      ? {
          title: `Об'єднай швидкі комунікації (${quickCommunicationOpen.length})`,
          reason: "Відкрито кілька комунікаційних задач. Краще закрити їх одним блоком.",
          tier: "quick_comm_batch"
        }
      : null;

  const tiered = uniqRecommendations([
    topTask(overduePlanned, timezone, "Прострочену заплановану задачу варто підтягнути першою.", "overdue"),
    topTask(hardToday, timezone, "Жорстке зобов'язання на сьогодні потребує захисту.", "hard_today"),
    topTask(
      dueTodayWithoutPlannedStart,
      timezone,
      "Є задача з дедлайном на сьогодні без планованого старту. Її треба свідомо включити в день або закрити.",
      "due_today_unscheduled"
    ),
    topTask(
      protectedPending,
      timezone,
      "Захищена важлива задача ще не закрита і не повинна випадати з дня.",
      "protected_essential"
    ),
    topTask(
      highImportanceToday,
      timezone,
      "На сьогодні вже є запланована задача з високою важливістю.",
      "high_importance"
    ),
    quickBatchRecommendation
  ]);

  const primaryRecommendation = tiered[0] ?? null;
  const secondaryRecommendations = tiered.slice(1, 3);

  const plannedTodayCount = scheduledToday.length;
  const protectedScheduledTodayCount = protectedPending.filter((task) =>
    isScheduledForDay(task, timezone, dayStart, dayEnd)
  ).length;

  const overloadFlags: Array<{ code: string; message: string }> = [];
  if (plannedTodayCount > planningThresholds.plannedTodayOverload) {
    overloadFlags.push({ code: "too_many_planned_today", message: "На сьогодні заплановано забагато задач." });
  }
  if (overduePlanned.length > planningThresholds.overdueOverload) {
    overloadFlags.push({ code: "too_many_overdue", message: "Прострочених запланованих задач уже забагато." });
  }
  if (dueTodayWithoutPlannedStart.length > 0) {
    overloadFlags.push({
      code: "due_today_without_planned_start",
      message: "Є задачі з дедлайном на сьогодні без планованого старту. Вони не входять у день автоматично."
    });
  }
  if (scheduledToday.length > 0 && scheduledMissingEstimateCount > 0) {
    overloadFlags.push({
      code: "scheduled_missing_estimates",
      message: `Для ${scheduledMissingEstimateCount} запланованих задач ще немає оцінки, тож фактичне навантаження дня неповне.`
    });
  }
  if (protectedPending.length > 0 && protectedScheduledTodayCount === 0) {
    overloadFlags.push({
      code: "protected_essentials_missing_today",
      message: "Захищені важливі задачі ще відкриті, але не представлені в сьогоднішньому плані."
    });
  }
  if (quickCommunicationOpen.length >= planningThresholds.quickCommunicationOverload) {
    overloadFlags.push({
      code: "excessive_quick_communication",
      message: "Швидких комунікацій забагато. Краще виконати їх одним блоком."
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
      reason: "Захищену важливу задачу вже не раз відкладали."
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
      reason: "Регулярна важлива задача не закривається вже кілька циклів."
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
      reason: "Схоже, цю задачу системно витискають інші справи."
    }));

  const completedTodayCount = events.filter((event) => event.event_type === "completed").length;
  const movedTodayEvents = events.filter(
    (event) => event.event_type === "postponed" || event.event_type === "rescheduled"
  );
  const movedTodayCount = movedTodayEvents.length;
  const cancelledTodayCount = events.filter(
    (event) => event.event_type === "status_changed" && event.new_status === "cancelled"
  ).length;

  const protectedEssentialsMissedToday = protectedPending.filter(
    (task) => !isScheduledForDay(task, timezone, dayStart, dayEnd)
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
      dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
      backlogCount,
      overduePlannedCount: overduePlanned.length,
      quickCommunicationOpenCount: quickCommunicationOpen.length,
      quickCommunicationBatchingRecommended:
        quickCommunicationOpen.length >= planningThresholds.quickCommunicationBatching,
      protectedPendingCount: protectedPending.length,
      scheduledKnownEstimateMinutes,
      scheduledMissingEstimateCount,
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
