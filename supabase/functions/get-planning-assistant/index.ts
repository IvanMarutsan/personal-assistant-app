import { DateTime } from "npm:luxon@3.6.1";
import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { planningThresholds } from "../_shared/planning-config.ts";
import { buildPlanningContext, validateScopeDate } from "../_shared/planning-conversation.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { summarizeTaskTypeSignals } from "../_shared/task-type-signals.ts";

type TaskRow = {
  id: string;
  title: string;
  task_type:
    | "communication"
    | "publishing"
    | "admin"
    | "planning"
    | "tech"
    | "content"
    | "meeting"
    | "review"
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
  planning_flexibility: "essential" | "flexible" | null;
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

type WorklogRow = {
  source: string | null;
  projects?: { name: string } | { name: string }[] | null;
};
function taskProjectName(task: TaskRow): string | null {
  if (!task.projects) return null;
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? null;
  return task.projects.name ?? null;
}

function worklogProjectName(worklog: WorklogRow): string | null {
  if (!worklog.projects) return null;
  if (Array.isArray(worklog.projects)) return worklog.projects[0]?.name ?? null;
  return worklog.projects.name ?? null;
}

function summarizeWorklogs(worklogs: WorklogRow[]) {
  const byProject = new Map<string, number>();
  const bySource = new Map<string, number>();
  let withoutProjectCount = 0;

  for (const worklog of worklogs) {
    const project = worklogProjectName(worklog);
    if (project) {
      byProject.set(project, (byProject.get(project) ?? 0) + 1);
    } else {
      withoutProjectCount += 1;
    }

    const source = worklog.source ?? "other";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }

  return {
    count: worklogs.length,
    withoutProjectCount,
    topProjects: Array.from(byProject.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk-UA"))
      .slice(0, 3)
      .map(([name, count]) => ({ name, count })),
    sourceCounts: Array.from(bySource.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk-UA"))
      .map(([source, count]) => ({ source, count }))
  };
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

function flexibilityRank(value: TaskRow["planning_flexibility"]): number {
  if (value === "essential") return 0;
  if (value === "flexible") return 2;
  return 1;
}

function recommendationReason(task: TaskRow, reason: string): string {
  if (task.planning_flexibility === "essential") {
    return `${reason} Задачу позначено як обов'язкову, тож її краще не зрушувати без потреби.`;
  }
  if (task.planning_flexibility === "flexible") {
    return `${reason} Задача позначена як гнучка, тож під тиском її легше посунути.`;
  }
  return reason;
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
    const flexibilityDelta = flexibilityRank(a.planning_flexibility) - flexibilityRank(b.planning_flexibility);
    if (flexibilityDelta !== 0) return flexibilityDelta;
    return b.importance - a.importance;
  });

  const selected = sorted[0];
  if (!selected) return null;

  return {
    taskId: selected.id,
    title: selected.title,
    reason: recommendationReason(selected, reason),
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
  const url = new URL(req.url);
  const todayStart = now.startOf("day");
  const scopeType = url.searchParams.get("scopeType") === "week" ? "week" : "day";
  const scopeDate = validateScopeDate(url.searchParams.get("scopeDate")) ?? todayStart.toFormat("yyyy-MM-dd");

  if (scopeType === "week") {
    const context = await buildPlanningContext(supabase, sessionUser.userId, "week", scopeDate);
    if (context.scopeType !== "week") {
      return jsonResponse({ ok: false, error: "invalid_scope_context" }, 500);
    }

    const weekDays = context.weekDays;
    const formatDayLabel = (value: string) => DateTime.fromISO(value, { zone: timezone }).setLocale("uk").toFormat("ccc d LLL");
    const overloadedDays = weekDays.filter(
      (day) =>
        day.dueWithoutPlannedStartCount > 0 ||
        day.plannedCount >= planningThresholds.plannedTodayOverload ||
        ((day.scheduledKnownEstimateMinutes + (day.calendarBusyMinutes ?? 0)) >= 480) ||
        (day.scheduledMissingEstimateCount >= 2 && day.plannedCount >= 2)
    );
    const lighterDays = weekDays.filter(
      (day) =>
        day.plannedCount === 0 &&
        day.dueWithoutPlannedStartCount === 0 &&
        (day.calendarBusyMinutes ?? 0) < 180 &&
        day.calendarEventCount <= 2
    );
    const weekTaskTypeSignals = summarizeTaskTypeSignals(
      [
        ...context.scheduledInWeek.map((task) => ({ task_type: task.taskType })),
        ...context.dueInWeekWithoutPlannedStart.map((task) => ({ task_type: task.taskType }))
      ],
      "week"
    );

    const { data: reviewTasksData, error: reviewTasksError } = await supabase
      .from("tasks")
      .select(
        "id, title, task_type, status, importance, commitment_type, is_recurring, is_protected_essential, postpone_count, due_at, scheduled_for, estimated_minutes, planning_flexibility, projects(name)"
      )
      .eq("user_id", sessionUser.userId)
      .neq("status", "cancelled")
      .limit(500);

    if (reviewTasksError) {
      return jsonResponse({ ok: false, error: "tasks_fetch_failed" }, 500);
    }

    const { data: weekEventsData, error: weekEventsError } = await supabase
      .from("task_events")
      .select("task_id, event_type, reason_code, new_status, created_at")
      .eq("user_id", sessionUser.userId)
      .gte("created_at", context.scopeStartIso)
      .lte("created_at", context.scopeEndIso)
      .limit(1000);

    if (weekEventsError) {
      return jsonResponse({ ok: false, error: "events_fetch_failed" }, 500);
    }

    const reviewTasks = (reviewTasksData ?? []) as TaskRow[];
    const weekEvents = (weekEventsData ?? []) as TaskEventRow[];
    const taskById = new Map(reviewTasks.map((task) => [task.id, task]));
    const moveReasonLabels: Record<string, string> = {
      reprioritized: "переплановувалась через зміну пріоритетів",
      blocked_dependency: "зависала через блокер",
      urgent_interrupt: "зсувалась через термінові переривання",
      calendar_conflict: "зсувалась через календарний конфлікт",
      underestimated: "виявилась більшою, ніж очікувалось",
      low_energy: "не зайшла в тиждень через нестачу ресурсу",
      waiting_on_external: "чекала зовнішнього кроку",
      waiting_response: "чекала відповіді",
      personal_issue: "зсунулась через особисті обставини",
      other: "зсувалась упродовж тижня"
    };
    const overloadedDayKeys = new Set(overloadedDays.map((day) => day.scopeDate));
    const completedTaskIds = new Set<string>();
    const done = weekEvents
      .filter((event) => event.task_id && (event.event_type === "completed" || event.new_status === "done"))
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
      .flatMap((event) => {
        const taskId = event.task_id ?? null;
        if (!taskId || completedTaskIds.has(taskId)) return [];
        completedTaskIds.add(taskId);
        const task = taskById.get(taskId);
        if (!task) return [];
        return [{
          taskId,
          title: task.title,
          reason: taskProjectName(task)
            ? `Закрито цього тижня в проєкті ${taskProjectName(task)}.`
            : "Закрито цього тижня."
        }];
      })
      .slice(0, 5);

    const notDone = context.scheduledInWeek
      .filter((task) => task.status !== "done" && task.status !== "cancelled")
      .slice(0, 5)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        reason: task.scheduledFor
          ? `Була в плані на ${DateTime.fromISO(task.scheduledFor, { zone: "utc" }).setZone(timezone).setLocale("uk").toFormat("ccc d LLL")}, але тиждень закінчується без закриття.`
          : "Була в активному плані тижня, але не закрита."
      }));

    const movedByTask = new Map<string, TaskEventRow[]>();
    for (const event of weekEvents) {
      if (!event.task_id) continue;
      if (event.event_type !== "rescheduled" && event.event_type !== "postponed" && event.event_type !== "missed") continue;
      const list = movedByTask.get(event.task_id) ?? [];
      list.push(event);
      movedByTask.set(event.task_id, list);
    }
    const moved = [...movedByTask.entries()]
      .map(([taskId, events]) => {
        const task = taskById.get(taskId);
        if (!task) return null;
        const latestEvent = [...events].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0] ?? null;
        const count = events.length;
        const reasonLabel = latestEvent?.reason_code ? moveReasonLabels[latestEvent.reason_code] ?? moveReasonLabels.other : moveReasonLabels.other;
        return {
          taskId,
          title: task.title,
          sortKey: latestEvent?.created_at ?? "",
          reason: count > 1
            ? `За тиждень зсувалась ${count} рази і ${reasonLabel}.`
            : `За тиждень зсунулась і ${reasonLabel}.`
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item)
      .sort((a, b) => new Date(b.sortKey || 0).getTime() - new Date(a.sortKey || 0).getTime())
      .slice(0, 5)
      .map(({ taskId, title, reason }) => ({ taskId, title, reason }));

    const shouldMove = [
      ...context.dueInWeekWithoutPlannedStart.map((task) => ({
        taskId: task.id,
        title: task.title,
        reason: "Дедлайн уже був у межах тижня, але для задачі так і не з'явився явний слот. Її варто або пересунути свідомо, або перепланувати окремо."
      })),
      ...context.scheduledInWeek
        .filter((task) => task.scheduledFor && task.planningFlexibility === "flexible")
        .filter((task) => {
          const dayKey = DateTime.fromISO(task.scheduledFor ?? "", { zone: "utc" }).setZone(timezone).toISODate();
          return dayKey ? overloadedDayKeys.has(dayKey) : false;
        })
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          reason: "Стоїть у напруженому дні тижня й виглядає кандидатом на ручне перенесення."
        }))
    ]
      .filter((item, index, list) => list.findIndex((candidate) => candidate.taskId === item.taskId) === index)
      .slice(0, 5);

    const shouldKill = context.relevantBacklog
      .filter(
        (task) =>
          !task.isProtectedEssential &&
          !task.dueAt &&
          (task.taskType === "someday" || task.taskType === "review" || task.planningFlexibility === "flexible")
      )
      .slice(0, 4)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        reason: "Висить у беклозі без дедлайну і без явного слоту. Якщо цінність не зросла, її можна сміливо переглянути на видалення."
      }));

    const topPressureDay = [...weekDays].sort((a, b) => {
      const aScore = a.dueWithoutPlannedStartCount * 5 + a.plannedCount * 2 + a.scheduledMissingEstimateCount + ((a.calendarBusyMinutes ?? 0) / 120);
      const bScore = b.dueWithoutPlannedStartCount * 5 + b.plannedCount * 2 + b.scheduledMissingEstimateCount + ((b.calendarBusyMinutes ?? 0) / 120);
      return bScore - aScore;
    })[0] ?? null;
    const primaryRecommendation = context.notableDeadlines[0]
      ? {
          taskId: context.notableDeadlines[0].taskId,
          title: context.notableDeadlines[0].title,
          reason: `У тижні є помітний дедлайн, тож цю задачу варто явно втримати в полі уваги до ${DateTime.fromISO(context.notableDeadlines[0].dueAt, { zone: "utc" }).setZone(timezone).setLocale("uk").toFormat("d LLL")}.`,
          tier: "due_today_unscheduled" as const
        }
      : topPressureDay
        ? {
            title: `Перевір ${formatDayLabel(topPressureDay.scopeDate)}`,
            reason: `На цей день уже сходяться план, дедлайни без плану або помітне навантаження. Краще вручну розвантажити саме його першим.`,
            tier: "high_importance" as const
          }
        : context.relevantBacklog[0]
          ? {
              taskId: context.relevantBacklog[0].id,
              title: context.relevantBacklog[0].title,
              reason: `У тижня ще є простір для ручного планування, а ця задача лишається в беклозі без явного дня.`,
              tier: "protected_essential" as const
            }
          : null;
    const secondaryRecommendations = [
      overloadedDays[0]
        ? {
            title: `Напружений день: ${formatDayLabel(overloadedDays[0].scopeDate)}`,
            reason: `Тут уже є тиск від плану, дедлайнів або календаря. Варто переглянути цей день обережно, без автоматичних рішень.`,
            tier: "overdue" as const
          }
        : null,
      lighterDays[0]
        ? {
            title: `Легший день: ${formatDayLabel(lighterDays[0].scopeDate)}`,
            reason: `У цьому дні менше фіксованого навантаження, тож його можна тримати як резерв для ручного перерозподілу.`,
            tier: "quick_comm_batch" as const
          }
        : null,
      context.backlogCount > 0
        ? {
            title: `Беклог тижня: ${context.backlogCount}`,
            reason: `Частина задач ще не прив'язана до днів тижня, тому тиск беклогу варто тримати окремо від уже запланованих днів.`,
            tier: "high_importance" as const
          }
        : null
    ].filter((item): item is NonNullable<typeof item> => !!item);

    const protectedEssentialRisk = context.scheduledInWeek
      .filter((task) => task.isProtectedEssential)
      .slice(0, 3)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        project: task.projectName,
        postponeCount: 0,
        reason: "Важливу задачу вже поставлено в тиждень, тож її краще не зрушувати без явної потреби."
      }));
    const recurringEssentialRisk = context.scheduledInWeek
      .filter((task) => task.taskType === "recurring_essential")
      .slice(0, 3)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        project: task.projectName,
        postponeCount: 0,
        reason: "Регулярна важлива задача вже входить у план тижня і потребує помітного слоту."
      }));
    const squeezedOutRisk = context.relevantBacklog
      .filter((task) => task.isProtectedEssential || task.planningFlexibility === "essential")
      .slice(0, 3)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        project: task.projectName,
        postponeCount: 0,
        reason: "У беклозі лишається задача, яку небажано довго тримати без дня в межах цього тижня."
      }));
    const overloadFlags = [
      overloadedDays.length > 0
        ? { code: "week_overload_days", message: `У тижні є ${overloadedDays.length} напружених днів, які варто переглянути вручну.` }
        : null,
      context.dueWithoutPlannedStartCount > 0
        ? { code: "week_due_without_plan", message: `У межах тижня є ${context.dueWithoutPlannedStartCount} задач із дедлайном без планованого старту.` }
        : null,
      context.scheduledMissingEstimateCount > 0
        ? { code: "week_missing_estimates", message: `Для тижня бракує оцінок у ${context.scheduledMissingEstimateCount} уже запланованих задач.` }
        : null,
      context.backlogCount >= planningThresholds.plannedTodayOverload
        ? { code: "week_backlog_pressure", message: `Беклог тижня вже помітний: ${context.backlogCount} задач без призначеного дня.` }
        : null
    ].filter((item): item is NonNullable<typeof item> => !!item);
    weekTaskTypeSignals.signals.slice(0, 2).forEach((message, index) => {
      overloadFlags.push({ code: `week_task_type_${index}`, message });
    });

    return jsonResponse({
      ok: true,
      generatedAt: DateTime.utc().toISO(),
      timezone,
      scopeType: "week",
      scopeDate: context.scopeDate,
      rulesVersion: "v1-deterministic-week",
      whatNow: {
        primary: primaryRecommendation,
        secondary: secondaryRecommendations
      },
      overload: {
        hasOverload: overloadFlags.length > 0,
        plannedTodayCount: context.plannedCount,
        dueTodayWithoutPlannedStartCount: context.dueWithoutPlannedStartCount,
        backlogCount: context.backlogCount,
        overduePlannedCount: overloadedDays.length,
        quickCommunicationOpenCount: 0,
        quickCommunicationBatchingRecommended: false,
        protectedPendingCount: weekDays.reduce((sum, day) => sum + day.essentialScheduledCount, 0),
        scheduledKnownEstimateMinutes: context.scheduledKnownEstimateMinutes,
        scheduledMissingEstimateCount: context.scheduledMissingEstimateCount,
        taskTypeSignals: weekTaskTypeSignals.signals,
        flags: overloadFlags
      },
      essentialRisk: {
        protectedEssentialRisk,
        recurringEssentialRisk,
        squeezedOutRisk
      },
      dailyReview: {
        completedTodayCount: 0,
        movedTodayCount: 0,
        cancelledTodayCount: 0,
        protectedEssentialsMissedToday: 0,
        topMovedReasons: [],
        worklogs: context.worklogs
      },
      weeklyReview: {
        done,
        notDone,
        moved,
        shouldMove,
        shouldKill
      },
      weekDays: context.weekDays,
      notableDeadlines: context.notableDeadlines,
      appliedThresholds: planningThresholds
    });
  }

  const dayStart = DateTime.fromISO(scopeDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const overdueReference = dayStart < todayStart ? dayEnd : dayStart > todayStart ? dayStart : now;

  const { data: tasksData, error: tasksError } = await supabase
    .from("tasks")
    .select(
      "id, title, task_type, status, importance, commitment_type, is_recurring, is_protected_essential, postpone_count, due_at, scheduled_for, estimated_minutes, planning_flexibility, projects(name)"
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

  const { data: worklogsData, error: worklogsError } = await supabase
    .from("worklogs")
    .select("source, projects(name)")
    .eq("user_id", sessionUser.userId)
    .gte("occurred_at", dayStart.toUTC().toISO())
    .lte("occurred_at", dayEnd.toUTC().toISO())
    .limit(500);

  if (worklogsError) {
    return jsonResponse({ ok: false, error: "worklogs_fetch_failed" }, 500);
  }

  const worklogs = (worklogsData ?? []) as WorklogRow[];
  const worklogSummary = summarizeWorklogs(worklogs);


  const activeTasks = tasks.filter((task) => task.status !== "done");
  const actionableTasks = activeTasks.filter(
    (task) => task.status === "planned" || task.status === "in_progress"
  );

  const scheduledToday = actionableTasks.filter((task) =>
    isScheduledForDay(task, timezone, dayStart, dayEnd)
  );
  const overduePlanned = actionableTasks.filter((task) => isScheduledOverdue(task, overdueReference));
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
  const dayTaskTypeSignals = summarizeTaskTypeSignals(
    [...scheduledToday, ...dueTodayWithoutPlannedStart],
    "day"
  );

  const quickCommunicationOpen = actionableTasks.filter(
    (task) => task.task_type === "quick_communication" || task.task_type === "communication"
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
    topTask(hardToday, timezone, "Жорстке зобов’язання на цей день краще не стискати без потреби.", "hard_today"),
    topTask(
      dueTodayWithoutPlannedStart,
      timezone,
      "Є задача з дедлайном на цей день без запланованого старту. Її треба окремо вирішити в плані цього дня.",
      "due_today_unscheduled"
    ),
    topTask(
      protectedPending,
      timezone,
      "Захищену важливу задачу ще не закрито й не варто непомітно витісняти з плану дня.",
      "protected_essential"
    ),
    topTask(
      highImportanceToday,
      timezone,
      "На цей день уже є задача з високою важливістю.",
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
    overloadFlags.push({ code: "too_many_planned_today", message: "На цей день заплановано забагато задач." });
  }
  if (overduePlanned.length > planningThresholds.overdueOverload) {
    overloadFlags.push({ code: "too_many_overdue", message: "Прострочених запланованих задач уже забагато." });
  }
  if (dueTodayWithoutPlannedStart.length > 0) {
    overloadFlags.push({
      code: "due_today_without_planned_start",
      message: "Є задачі з дедлайном на цей день без запланованого старту. Їх треба окремо вирішити."
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
      message: "Захищені важливі задачі відкриті, але не заплановані на цей день."
    });
  }
  if (quickCommunicationOpen.length >= planningThresholds.quickCommunicationOverload) {
    overloadFlags.push({
      code: "excessive_quick_communication",
      message: "Швидких комунікацій забагато. Краще виконати їх одним блоком."
    });
  }
  if (worklogSummary.count >= 3) {
    overloadFlags.push({
      code: "reactive_work_logged",
      message: "У цей день уже є кілька контекстних записів. Частина часу пішла на реактивні дрібні дії або перемикання контексту."
    });
  }
  dayTaskTypeSignals.signals.slice(0, 2).forEach((message, index) => {
    overloadFlags.push({ code: `day_task_type_${index}`, message });
  });

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
    scopeType: "day",
    scopeDate,
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
      taskTypeSignals: dayTaskTypeSignals.signals,
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
      topMovedReasons,
      worklogs: worklogSummary
    },
    weeklyReview: null,
    weekDays: [],
    notableDeadlines: [],
    appliedThresholds: planningThresholds
  });
});
















