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
  created_at: string;
};

type AiAdvisorPayload = {
  whatMattersMostNow: string;
  suggestedNextAction: {
    taskId: string | null;
    title: string;
    reason: string;
  };
  suggestedDefer: {
    taskId: string | null;
    title: string;
    reason: string;
  };
  protectedEssentialsWarning: {
    hasWarning: boolean;
    message: string;
  };
  explanation: string;
  evidence: string[];
};

type AdvisorResponse = {
  ok: true;
  generatedAt: string;
  timezone: string;
  model: string | null;
  source: "ai" | "fallback_rules";
  fallbackReason: string | null;
  contextSnapshot: {
    currentLocalTime: string;
    quickCommunicationOpenCount: number;
    plannedTodayCount: number;
    dueTodayWithoutPlannedStartCount: number;
    backlogCount: number;
    overduePlannedCount: number;
    protectedPendingCount: number;
    recurringAtRiskCount: number;
    topMovedReasonsToday: Array<{ reason: string; count: number }>;
    dailyReview: {
      completedTodayCount: number;
      movedTodayCount: number;
      cancelledTodayCount: number;
      protectedEssentialsMissedToday: number;
    };
  };
  advisor: AiAdvisorPayload;
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

function toRankedReasons(rows: TaskEventRow[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    if (!row.reason_code) return;
    counts.set(row.reason_code, (counts.get(row.reason_code) ?? 0) + 1);
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function pickNextAction(
  overdue: TaskRow[],
  hardToday: TaskRow[],
  dueTodayWithoutPlannedStart: TaskRow[],
  protectedPending: TaskRow[],
  highImportanceToday: TaskRow[]
): TaskRow | null {
  const first = overdue[0] ?? hardToday[0] ?? dueTodayWithoutPlannedStart[0] ?? protectedPending[0] ?? highImportanceToday[0];
  return first ?? null;
}

function pickDeferCandidate(actionableTasks: TaskRow[], zone: string, dayStart: DateTime, dayEnd: DateTime): TaskRow | null {
  const deferable = actionableTasks.filter(
    (task) =>
      !isScheduledForDay(task, zone, dayStart, dayEnd) &&
      !(isBacklogTask(task) && isDueOnDay(task, zone, dayStart, dayEnd)) &&
      !task.is_protected_essential &&
      (task.task_type === "quick_communication" ||
        task.task_type === "admin_operational" ||
        task.task_type === "someday")
  );

  const sorted = [...deferable].sort((a, b) => {
    const importanceDelta = a.importance - b.importance;
    if (importanceDelta !== 0) return importanceDelta;
    return (a.postpone_count ?? 0) - (b.postpone_count ?? 0);
  });
  return sorted[0] ?? null;
}

function fallbackAdvisor(input: {
  timezone: string;
  now: DateTime;
  plannedTodayCount: number;
  dueTodayWithoutPlannedStartCount: number;
  backlogCount: number;
  overduePlannedCount: number;
  quickCommunicationOpenCount: number;
  protectedPendingCount: number;
  recurringAtRiskCount: number;
  topMovedReasonsToday: Array<{ reason: string; count: number }>;
  dailyReview: {
    completedTodayCount: number;
    movedTodayCount: number;
    cancelledTodayCount: number;
    protectedEssentialsMissedToday: number;
  };
  nextAction: TaskRow | null;
  deferCandidate: TaskRow | null;
}): AiAdvisorPayload {
  const warningActive = input.protectedPendingCount > 0 || input.recurringAtRiskCount > 0;

  return {
    whatMattersMostNow: input.nextAction
      ? `Почни з "${input.nextAction.title}".`
      : "Термінового фокусу не виявлено. Обери одну вже заплановану на день задачу й доведи її до завершення.",
    suggestedNextAction: {
      taskId: input.nextAction?.id ?? null,
      title: input.nextAction?.title ?? "Почати одну заплановану задачу",
      reason:
        input.overduePlannedCount > 0
          ? "Є прострочені заплановані задачі. Якщо витягнути одну вперед, день стане керованішим."
          : input.dueTodayWithoutPlannedStartCount > 0
          ? "Є задача з дедлайном на сьогодні без планованого старту. Її варто свідомо включити в день або закрити."
          : "Це найпріоритетніша наступна дія за поточними детермінованими сигналами."
    },
    suggestedDefer: {
      taskId: input.deferCandidate?.id ?? null,
      title: input.deferCandidate?.title ?? "Немає очевидної задачі для відкладання",
      reason: input.deferCandidate
        ? "Ця задача менш термінова, ніж уже заплановані, прострочені або дедлайнові справи на сьогодні."
        : "Тримайся поточного плану й не додавай зайвого обсягу."
    },
    protectedEssentialsWarning: {
      hasWarning: warningActive,
      message: warningActive
        ? "Є ризик, що захищені або регулярні важливі справи випадуть із сьогоднішнього дня."
        : "Ознак негайного витіснення захищених важливих справ зараз немає."
    },
    explanation: `Станом на ${input.now.toFormat("HH:mm")} (${input.timezone}) на сьогодні є ${input.plannedTodayCount} задач у денному плані, ${input.dueTodayWithoutPlannedStartCount} задач із дедлайном сьогодні без планованого старту, ${input.overduePlannedCount} прострочених запланованих задач і ${input.backlogCount} задач у беклозі.`,
    evidence: [
      `planned_today=${input.plannedTodayCount}`,
      `due_today_without_planned_start=${input.dueTodayWithoutPlannedStartCount}`,
      `backlog_count=${input.backlogCount}`,
      `overdue_planned=${input.overduePlannedCount}`,
      `protected_pending=${input.protectedPendingCount}`,
      `quick_communication_open=${input.quickCommunicationOpenCount}`
    ]
  };
}

function parseAiPayload(raw: string): AiAdvisorPayload | null {
  try {
    const parsed = JSON.parse(raw) as AiAdvisorPayload;
    if (
      !parsed ||
      typeof parsed.whatMattersMostNow !== "string" ||
      !parsed.suggestedNextAction ||
      !parsed.suggestedDefer ||
      !parsed.protectedEssentialsWarning ||
      typeof parsed.explanation !== "string" ||
      !Array.isArray(parsed.evidence)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function generateAiAdvisor(input: {
  model: string;
  apiKey: string;
  context: Record<string, unknown>;
}): Promise<AiAdvisorPayload | null> {
  const requestBody = {
    model: input.model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "Ти планувальний радник лише для читання в застосунку персонального виконання. Ніколи не пропонуй автоматичних змін задач. Використовуй лише наданий контекст. Чітко розрізняй три категорії: задачі, заплановані на сьогодні; задачі з дедлайном на сьогодні без планованого старту; беклог без планового старту. Відповідай коротко, практично й українською мовою."
      },
      {
        role: "user",
        content: `Поверни лише строгий JSON з ключами whatMattersMostNow, suggestedNextAction, suggestedDefer, protectedEssentialsWarning, explanation, evidence. Усі значення для користувача мають бути українською мовою. Не називай беклог "запланованим на сьогодні". Контекст: ${JSON.stringify(
          input.context
        )}`
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "planning_advisor_response",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            whatMattersMostNow: { type: "string" },
            suggestedNextAction: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: ["string", "null"] },
                title: { type: "string" },
                reason: { type: "string" }
              },
              required: ["taskId", "title", "reason"]
            },
            suggestedDefer: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: ["string", "null"] },
                title: { type: "string" },
                reason: { type: "string" }
              },
              required: ["taskId", "title", "reason"]
            },
            protectedEssentialsWarning: {
              type: "object",
              additionalProperties: false,
              properties: {
                hasWarning: { type: "boolean" },
                message: { type: "string" }
              },
              required: ["hasWarning", "message"]
            },
            explanation: { type: "string" },
            evidence: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 6
            }
          },
          required: [
            "whatMattersMostNow",
            "suggestedNextAction",
            "suggestedDefer",
            "protectedEssentialsWarning",
            "explanation",
            "evidence"
          ]
        }
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) return null;
  return parseAiPayload(raw);
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
  const sevenDaysAgo = now.minus({ days: 7 }).startOf("day");

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

  const { data: eventsData, error: eventsError } = await supabase
    .from("task_events")
    .select("event_type, reason_code, new_status, created_at")
    .eq("user_id", sessionUser.userId)
    .gte("created_at", sevenDaysAgo.toUTC().toISO())
    .lte("created_at", dayEnd.toUTC().toISO())
    .limit(1000);

  if (eventsError) {
    return jsonResponse({ ok: false, error: "events_fetch_failed" }, 500);
  }

  const tasks = (tasksData ?? []) as TaskRow[];
  const recentEvents = (eventsData ?? []) as TaskEventRow[];
  const todayEvents = recentEvents.filter((row) => {
    const dt = DateTime.fromISO(row.created_at, { zone: "utc" }).setZone(timezone);
    return dt.isValid && dt >= dayStart && dt <= dayEnd;
  });

  const actionableTasks = tasks.filter((task) => task.status === "planned" || task.status === "in_progress");
  const scheduledToday = actionableTasks
    .filter((task) => isScheduledForDay(task, timezone, dayStart, dayEnd))
    .sort((a, b) => (taskScheduledTime(a, timezone)?.toMillis() ?? 0) - (taskScheduledTime(b, timezone)?.toMillis() ?? 0));
  const overduePlanned = actionableTasks
    .filter((task) => isScheduledOverdue(task, now))
    .sort((a, b) => (taskScheduledTime(a, timezone)?.toMillis() ?? 0) - (taskScheduledTime(b, timezone)?.toMillis() ?? 0));
  const dueTodayWithoutPlannedStart = actionableTasks
    .filter((task) => isBacklogTask(task) && isDueOnDay(task, timezone, dayStart, dayEnd))
    .sort((a, b) => (taskDueTime(a, timezone)?.toMillis() ?? 0) - (taskDueTime(b, timezone)?.toMillis() ?? 0));
  const backlog = actionableTasks
    .filter((task) => isBacklogTask(task))
    .sort((a, b) => {
      const aImportance = b.importance - a.importance;
      if (aImportance !== 0) return aImportance;
      return a.title.localeCompare(b.title, "uk-UA");
    });
  const hardToday = scheduledToday.filter((task) => task.commitment_type === "hard");
  const highImportanceToday = scheduledToday.filter(
    (task) => task.importance >= planningThresholds.highImportanceMin
  );
  const protectedPending = actionableTasks.filter((task) => task.is_protected_essential);
  const recurringAtRisk = actionableTasks.filter(
    (task) =>
      (task.task_type === "recurring_essential" || task.task_type === "personal_essential") &&
      task.postpone_count >= planningThresholds.recurringRiskPostponeCount
  );
  const quickCommunicationOpen = actionableTasks.filter(
    (task) => task.task_type === "quick_communication"
  );

  const movedToday = todayEvents.filter((event) =>
    event.event_type === "postponed" ||
    event.event_type === "rescheduled" ||
    (event.event_type === "status_changed" && event.new_status === "planned")
  );

  const dailyReview = {
    completedTodayCount: todayEvents.filter((row) => row.event_type === "completed").length,
    movedTodayCount: movedToday.length,
    cancelledTodayCount: todayEvents.filter(
      (row) => row.event_type === "status_changed" && row.new_status === "cancelled"
    ).length,
    protectedEssentialsMissedToday: protectedPending.filter(
      (task) => !isScheduledForDay(task, timezone, dayStart, dayEnd)
    ).length
  };

  const topMovedReasonsToday = toRankedReasons(movedToday);
  const topMovedReasonsLast7d = toRankedReasons(
    recentEvents.filter((event) => event.event_type === "postponed" || event.event_type === "rescheduled")
  );

  const nextAction = pickNextAction(
    overduePlanned,
    hardToday,
    dueTodayWithoutPlannedStart,
    protectedPending,
    highImportanceToday
  );
  const deferCandidate = pickDeferCandidate(actionableTasks, timezone, dayStart, dayEnd);

  const aiContext = {
    generatedAt: now.toUTC().toISO(),
    timezone,
    currentLocalTime: now.toISO(),
    planningSemantics: {
      scheduledTodayCount: scheduledToday.length,
      dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
      backlogCount: backlog.length,
      overdueScheduledCount: overduePlanned.length,
      note: "Backlog визначається як scheduled_for IS NULL. Due-at без scheduled_for не вважається запланованим на сьогодні."
    },
    deterministicBaseline: {
      priorityOrder: [
        "overdue_planned",
        "hard_commitment_today",
        "due_today_without_planned_start",
        "protected_essential_pending",
        "high_importance_today",
        "quick_communication_batching"
      ],
      suggestedPrimaryTaskId: nextAction?.id ?? null,
      suggestedDeferTaskId: deferCandidate?.id ?? null
    },
    dailyReview,
    quickCommunicationLoad: {
      openCount: quickCommunicationOpen.length,
      batchingRecommended: quickCommunicationOpen.length >= planningThresholds.quickCommunicationBatching
    },
    movedReasons: {
      today: topMovedReasonsToday,
      last7d: topMovedReasonsLast7d
    },
    tasks: {
      scheduledToday: scheduledToday.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        importance: task.importance,
        commitmentType: task.commitment_type,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for,
        isProtectedEssential: task.is_protected_essential,
        isRecurring: task.is_recurring
      })),
      dueTodayWithoutPlannedStart: dueTodayWithoutPlannedStart.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        importance: task.importance,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      })),
      backlog: backlog.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        importance: task.importance,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      })),
      overduePlanned: overduePlanned.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        importance: task.importance,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      })),
      protectedEssentialsPending: protectedPending.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        postponeCount: task.postpone_count,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      })),
      recurringEssentialsAtRisk: recurringAtRisk.slice(0, 15).map((task) => ({
        id: task.id,
        title: task.title,
        project: taskProjectName(task),
        taskType: task.task_type,
        status: task.status,
        postponeCount: task.postpone_count,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      }))
    }
  };

  const fallback = fallbackAdvisor({
    timezone,
    now,
    plannedTodayCount: scheduledToday.length,
    dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
    backlogCount: backlog.length,
    overduePlannedCount: overduePlanned.length,
    quickCommunicationOpenCount: quickCommunicationOpen.length,
    protectedPendingCount: protectedPending.length,
    recurringAtRiskCount: recurringAtRisk.length,
    topMovedReasonsToday,
    dailyReview,
    nextAction,
    deferCandidate
  });

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4.1-mini";

  let source: AdvisorResponse["source"] = "fallback_rules";
  let fallbackReason: string | null = "openai_not_configured";
  let advisor = fallback;

  if (openAiApiKey) {
    try {
      const aiPayload = await generateAiAdvisor({
        model,
        apiKey: openAiApiKey,
        context: aiContext
      });
      if (aiPayload) {
        source = "ai";
        fallbackReason = null;
        advisor = aiPayload;
      } else {
        fallbackReason = "invalid_ai_response";
      }
    } catch {
      fallbackReason = "ai_request_failed";
    }
  }

  return jsonResponse({
    ok: true,
    generatedAt: now.toUTC().toISO(),
    timezone,
    model: source === "ai" ? model : null,
    source,
    fallbackReason,
    contextSnapshot: {
      currentLocalTime: now.toISO(),
      quickCommunicationOpenCount: quickCommunicationOpen.length,
      plannedTodayCount: scheduledToday.length,
      dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
      backlogCount: backlog.length,
      overduePlannedCount: overduePlanned.length,
      protectedPendingCount: protectedPending.length,
      recurringAtRiskCount: recurringAtRisk.length,
      topMovedReasonsToday,
      dailyReview
    },
    advisor
  } satisfies AdvisorResponse);
});
