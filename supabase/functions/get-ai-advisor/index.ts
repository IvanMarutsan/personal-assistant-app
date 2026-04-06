import { DateTime } from "npm:luxon@3.6.1";
import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { planningThresholds } from "../_shared/planning-config.ts";
import { buildCalendarDayContext, buildPlanningContext, validateScopeDate } from "../_shared/planning-conversation.ts";
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
  created_at: string;
};

type WorklogRow = {
  source: string | null;
  projects?: { name: string } | { name: string }[] | null;
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
function hasUkrainianSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return /[\u0400-\u04FF]/.test(text);
}
function sanitizeAiAdvisorPayload(
  payload: AiAdvisorPayload,
  taskLookup: Map<string, TaskRow>,
  fallback: AiAdvisorPayload
): AiAdvisorPayload | null {
  const visibleNarrative = [
    payload.whatMattersMostNow,
    payload.suggestedNextAction.reason,
    payload.suggestedDefer.reason,
    payload.protectedEssentialsWarning.message,
    payload.explanation
  ];
  if (visibleNarrative.some((item) => !hasUkrainianSignal(item))) {
    return null;
  }
  const nextTask = payload.suggestedNextAction.taskId
    ? taskLookup.get(payload.suggestedNextAction.taskId) ?? null
    : null;
  const deferTask = payload.suggestedDefer.taskId
    ? taskLookup.get(payload.suggestedDefer.taskId) ?? null
    : null;
  return {
    ...payload,
    suggestedNextAction: {
      ...payload.suggestedNextAction,
      title: nextTask?.title ?? fallback.suggestedNextAction.title
    },
    suggestedDefer: {
      ...payload.suggestedDefer,
      title: deferTask?.title ?? fallback.suggestedDefer.title
    }
  };
}

type AdvisorResponse = {
  ok: true;
  generatedAt: string;
  timezone: string;
  scopeType: "day" | "week";
  model: string | null;
  source: "ai" | "fallback_rules";
  fallbackReason: string | null;
  contextSnapshot: {
    scopeDate: string;
    currentLocalTime: string;
    quickCommunicationOpenCount: number;
    plannedTodayCount: number;
    dueTodayWithoutPlannedStartCount: number;
    backlogCount: number;
    overduePlannedCount: number;
    scheduledKnownEstimateMinutes: number;
    scheduledMissingEstimateCount: number;
    protectedPendingCount: number;
    recurringAtRiskCount: number;
    calendarDay: {
      connected: boolean;
      available: boolean;
      eventCount: number;
      busyMinutes: number | null;
      extraEventCount: number;
    };
    topMovedReasonsToday: Array<{ reason: string; count: number }>;
    dailyReview: {
      completedTodayCount: number;
      movedTodayCount: number;
      cancelledTodayCount: number;
      protectedEssentialsMissedToday: number;
    };
    worklogs: {
      count: number;
      withoutProjectCount: number;
      topProjects: Array<{ name: string; count: number }>;
      sourceCounts: Array<{ source: string; count: number }>;
    };
    weekDays: Array<{
      scopeDate: string;
      plannedCount: number;
      dueWithoutPlannedStartCount: number;
      scheduledKnownEstimateMinutes: number;
      scheduledMissingEstimateCount: number;
      calendarEventCount: number;
      calendarBusyMinutes: number | null;
      worklogCount: number;
      essentialScheduledCount: number;
      flexibleScheduledCount: number;
    }>;
    notableDeadlines: Array<{ taskId: string; title: string; projectName: string | null; dueAt: string }>;
  };
  advisor: AiAdvisorPayload;
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

function flexibilityPriority(value: TaskRow["planning_flexibility"]): number {
  if (value === "essential") return 0;
  if (value === "flexible") return 2;
  return 1;
}

function deferPriority(value: TaskRow["planning_flexibility"]): number {
  if (value === "flexible") return 0;
  if (value === "essential") return 2;
  return 1;
}

function annotateFlexibilityReason(task: TaskRow | null, reason: string): string {
  if (!task) return reason;
  if (task.planning_flexibility === "essential") {
    return `${reason} Задачу позначено як обов'язкову, тож рухати її варто лише за явної потреби.`;
  }
  if (task.planning_flexibility === "flexible") {
    return `${reason} Задача позначена як гнучка, тож її легше посунути під час ручного перепланування.`;
  }
  return reason;
}

function sortByActionPriority(tasks: TaskRow[], zone: string): TaskRow[] {
  return [...tasks].sort((a, b) => {
    const aDt = taskReferenceTime(a, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    const bDt = taskReferenceTime(b, zone)?.toMillis() ?? Number.MAX_SAFE_INTEGER;
    if (aDt !== bDt) return aDt - bDt;
    const flexibilityDelta = flexibilityPriority(a.planning_flexibility) - flexibilityPriority(b.planning_flexibility);
    if (flexibilityDelta !== 0) return flexibilityDelta;
    return b.importance - a.importance;
  });
}

function pickNextAction(
  overdue: TaskRow[],
  hardToday: TaskRow[],
  dueTodayWithoutPlannedStart: TaskRow[],
  protectedPending: TaskRow[],
  highImportanceToday: TaskRow[],
  zone: string
): TaskRow | null {
  const buckets = [overdue, hardToday, dueTodayWithoutPlannedStart, protectedPending, highImportanceToday];
  for (const bucket of buckets) {
    const first = sortByActionPriority(bucket, zone)[0];
    if (first) return first;
  }
  return null;
}

function pickDeferCandidate(actionableTasks: TaskRow[], zone: string, dayStart: DateTime, dayEnd: DateTime, now: DateTime): TaskRow | null {
  const deferable = actionableTasks.filter(
    (task) =>
      !isScheduledOverdue(task, now) &&
      !isDueOnDay(task, zone, dayStart, dayEnd) &&
      task.commitment_type !== "hard" &&
      !task.is_protected_essential &&
      task.planning_flexibility !== "essential" &&
      (task.task_type === "quick_communication" ||
        task.task_type === "admin_operational" ||
        task.task_type === "someday" ||
        task.planning_flexibility === "flexible")
  );

  const sorted = [...deferable].sort((a, b) => {
    const flexibilityDelta = deferPriority(a.planning_flexibility) - deferPriority(b.planning_flexibility);
    if (flexibilityDelta !== 0) return flexibilityDelta;
    const importanceDelta = a.importance - b.importance;
    if (importanceDelta !== 0) return importanceDelta;
    return (b.postpone_count ?? 0) - (a.postpone_count ?? 0);
  });
  return sorted[0] ?? null;
}

function fallbackAdvisor(input: {
  timezone: string;
  scopeDate: string;
  scopeLabel: string;
  isTodayScope: boolean;
  now: DateTime;
  plannedTodayCount: number;
  dueTodayWithoutPlannedStartCount: number;
  backlogCount: number;
  overduePlannedCount: number;
  scheduledKnownEstimateMinutes: number;
  scheduledMissingEstimateCount: number;
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
  worklogs: ReturnType<typeof summarizeWorklogs>;
}): AiAdvisorPayload {
  const warningActive = input.protectedPendingCount > 0 || input.recurringAtRiskCount > 0;
  const loadLine =
    input.scheduledKnownEstimateMinutes > 0
      ? `Відоме навантаження запланованого дня: ${input.scheduledKnownEstimateMinutes} хв.`
      : input.plannedTodayCount > 0
      ? "Для запланованого дня поки немає жодної оцінки тривалості."
      : "На сьогодні ще немає оціненого запланованого навантаження.";
  const estimateGapLine =
    input.scheduledMissingEstimateCount > 0
      ? ` Без оцінки лишаються ${input.scheduledMissingEstimateCount} запланованих задач.`
      : "";

  const worklogLine =
    input.worklogs.count > 0
      ? input.worklogs.count >= 3
        ? ` У цей день є ${input.worklogs.count} контекстних записи(ів), тож частина часу пішла на реактивні дрібні дії або перемикання контексту.`
        : ` У цей день є ${input.worklogs.count} контекстних записи(ів).`
      : "";
  return {
    whatMattersMostNow: input.nextAction
      ? input.dueTodayWithoutPlannedStartCount > 0
        ? `Почни з "${input.nextAction.title}" і окремо не проґав задачу з дедлайном без плану.`
        : `Почни з "${input.nextAction.title}".`
      : input.plannedTodayCount > 0
      ? "Тримай фокус на вже запланованому дні й закрий одну задачу за раз."
      : input.backlogCount > 0
      ? "На сьогодні немає явного плану. Якщо працюєш сьогодні, вибери одну задачу з беклогу свідомо, а не все одразу."
      : "Термінового фокусу не виявлено."
    ,
    suggestedNextAction: {
      taskId: input.nextAction?.id ?? null,
      title: input.nextAction?.title ?? "Почати одну заплановану задачу",
      reason:
        input.overduePlannedCount > 0
          ? "Є прострочені заплановані задачі. Якщо витягнути одну вперед, день стане керованішим."
          : input.dueTodayWithoutPlannedStartCount > 0
          ? "У плані є дедлайни без запланованого старту. Не забудь окремо вирішити, що саме реально робиш цього дня."
          : input.plannedTodayCount > 0
          ? "У тебе вже є заплановані задачі на цей день, тож краще рухатись по них, а не розширювати фокус."
          : "Це найкраща наступна дія за поточними сигналами."
    },
    suggestedDefer: {
      taskId: input.deferCandidate?.id ?? null,
      title: input.deferCandidate?.title ?? "Немає очевидної задачі для відкладання",
      reason: input.deferCandidate
        ? "Є задача, яку можна посунути без втрати планової цілі цього дня."
        : "Спершу закрий запланований день і не розширюй обсяг із беклогу."
    },
    protectedEssentialsWarning: {
      hasWarning: warningActive,
      message: warningActive
        ? "Є ризик, що захищені важливі справи цього дня можуть бути витіснені."
        : "Ознак негайного витіснення захищених важливих справ зараз немає."
    },
    explanation: input.isTodayScope
      ? `Станом на ${input.now.toFormat("HH:mm")} (${input.timezone}) у плані ${input.plannedTodayCount} задач, дедлайнів без плану ${input.dueTodayWithoutPlannedStartCount}, беклогу ${input.backlogCount}. ${loadLine}${estimateGapLine}`
      : `Для ${input.scopeLabel} у плані ${input.plannedTodayCount} задач, дедлайнів без плану ${input.dueTodayWithoutPlannedStartCount}, беклогу ${input.backlogCount}. ${loadLine}${estimateGapLine}${worklogLine}`,
    evidence: [
      `planned_today=${input.plannedTodayCount}`,
      `due_today_without_planned_start=${input.dueTodayWithoutPlannedStartCount}`,
      `backlog_count=${input.backlogCount}`,
      `scheduled_known_estimate_minutes=${input.scheduledKnownEstimateMinutes}`,
      `scheduled_missing_estimates=${input.scheduledMissingEstimateCount}`,
      `overdue_planned=${input.overduePlannedCount}`
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
  taskLookup: Map<string, TaskRow>;
  fallback: AiAdvisorPayload;
}): Promise<AiAdvisorPayload | null> {
  const requestBody = {
    model: input.model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "Ти планувальний радник лише для читання в застосунку персонального виконання. Ніколи не пропонуй автоматичних змін задач. Використовуй лише наданий контекст. Якщо scopeType = day, чітко розрізняй задачі, заплановані на цей день; задачі з дедлайном на цей день без планованого старту; і беклог без планового старту. Якщо scopeType = week, спирайся на тижневі підсумки, тиск окремих днів, дедлайни в межах тижня, беклог і read-only сигнали календаря та worklogs. Спирайся на наявні оцінки тривалості, але не вигадуй їх. Не називай беклог частиною вже сформованого плану. Відповідай коротко, практично, обережно й українською мовою.",
      },
      {
        role: "user",
        content: `Поверни лише строгий JSON з ключами whatMattersMostNow, suggestedNextAction, suggestedDefer, protectedEssentialsWarning, explanation, evidence. Усі значення для користувача мають бути українською мовою. Якщо в контексті є signals про known load, missing estimates, calendar load або worklogs, використовуй їх лише як grounded summary, без вигадування нових правил чи автоматичних рішень. Контекст: ${JSON.stringify(
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
  const parsed = parseAiPayload(raw);
  if (!parsed) return null;
  return sanitizeAiAdvisorPayload(parsed, input.taskLookup, input.fallback);
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

    const weekStart = DateTime.fromISO(context.scopeDate, { zone: timezone }).startOf("day");
    const weekEnd = weekStart.plus({ days: 6 }).endOf("day");
    const weekLabel = `${weekStart.setLocale("uk").toFormat("d LLL")} - ${weekEnd.setLocale("uk").toFormat("d LLL")}`;
    const overloadedDays = context.weekDays.filter(
      (day) =>
        day.dueWithoutPlannedStartCount > 0 ||
        day.plannedCount >= planningThresholds.plannedTodayOverload ||
        ((day.scheduledKnownEstimateMinutes + (day.calendarBusyMinutes ?? 0)) >= 480) ||
        (day.scheduledMissingEstimateCount >= 2 && day.plannedCount >= 2)
    );
    const lighterDays = context.weekDays.filter(
      (day) => day.plannedCount === 0 && day.dueWithoutPlannedStartCount === 0 && (day.calendarBusyMinutes ?? 0) < 180
    );
    const nextAction = context.notableDeadlines[0]
      ? context.dueInWeekWithoutPlannedStart.find((task) => task.id === context.notableDeadlines[0].taskId) ?? null
      : context.scheduledInWeek.find((task) => task.isProtectedEssential || task.planningFlexibility === "essential") ?? context.scheduledInWeek[0] ?? null;
    const deferCandidate = context.scheduledInWeek.find((task) => task.planningFlexibility === "flexible") ?? context.relevantBacklog[0] ?? null;
    const calendarWeek = {
      connected: context.weekDays.some((day) => day.calendarEventCount > 0 || day.calendarBusyMinutes !== null),
      available: context.weekDays.some((day) => day.calendarBusyMinutes !== null),
      eventCount: context.weekDays.reduce((sum, day) => sum + day.calendarEventCount, 0),
      busyMinutes: context.weekDays.reduce((sum, day) => sum + (day.calendarBusyMinutes ?? 0), 0),
      extraEventCount: 0
    };
    const fallback = {
      whatMattersMostNow:
        overloadedDays.length > 0
          ? `У тижні ${weekLabel} є щонайменше ${overloadedDays.length} напружених днів, тож спочатку варто перевірити їх вручну.`
          : `Тиждень ${weekLabel} виглядає відносно рівним, тож можна спокійно уточнити кілька слабких місць у плані.`,
      suggestedNextAction: {
        taskId: nextAction?.id ?? null,
        title: nextAction?.title ?? (overloadedDays[0] ? `Переглянути ${DateTime.fromISO(overloadedDays[0].scopeDate, { zone: timezone }).setLocale("uk").toFormat("cccc")}` : "Уточнити план тижня"),
        reason: context.notableDeadlines[0]
          ? `У тижні є помітний дедлайн, тож краще зафіксувати його місце в плані раніше.`
          : overloadedDays[0]
            ? `На цьому дні вже сходяться план, дедлайни без плану або календарне навантаження.`
            : `Уточни найважливішу задачу тижня й перевір, чи їй вистачає явного слоту.`
      },
      suggestedDefer: {
        taskId: deferCandidate?.id ?? null,
        title: deferCandidate?.title ?? (lighterDays[0] ? `Тримати ${DateTime.fromISO(lighterDays[0].scopeDate, { zone: timezone }).setLocale("uk").toFormat("cccc")} легшим` : "Не перевантажувати тиждень"),
        reason: deferCandidate
          ? `Ця задача виглядає гнучкішою, тож її простіше посунути вручну, якщо тиждень виявиться занадто щільним.`
          : `Якщо тиждень ущільниться, краще посунути менш критичні пункти, а не стискати всі дні однаково.`
      },
      protectedEssentialsWarning: {
        hasWarning: context.scheduledInWeek.some((task) => task.isProtectedEssential) && overloadedDays.length > 0,
        message:
          context.scheduledInWeek.some((task) => task.isProtectedEssential) && overloadedDays.length > 0
            ? "У тижні вже є важливі захищені задачі, тож розвантаження краще робити за рахунок гнучкіших пунктів."
            : "Критичного тиску на захищені задачі зараз не видно."
      },
      explanation: [
        `Заплановано в тижні: ${context.plannedCount}.`,
        context.dueWithoutPlannedStartCount > 0 ? `Є дедлайни без плану: ${context.dueWithoutPlannedStartCount}.` : null,
        context.scheduledMissingEstimateCount > 0 ? `Без оцінки лишаються ${context.scheduledMissingEstimateCount} задач.` : null,
        context.worklogs.count > 0 ? `Контекстних записів за тиждень: ${context.worklogs.count}.` : null
      ].filter((item): item is string => !!item).join(" "),
      evidence: [
        `У плані тижня: ${context.plannedCount}`,
        `Беклог: ${context.backlogCount}`,
        `Оцінене навантаження: ${context.scheduledKnownEstimateMinutes} хв`,
        overloadedDays[0] ? `Найнапруженіший день: ${DateTime.fromISO(overloadedDays[0].scopeDate, { zone: timezone }).setLocale("uk").toFormat("cccc d LLL")}` : `Легших днів: ${lighterDays.length}`
      ]
    } satisfies AiAdvisorPayload;
    const taskLookup = new Map(
      [...context.scheduledInWeek, ...context.dueInWeekWithoutPlannedStart, ...context.relevantBacklog].map((task) => [task.id, { title: task.title } as TaskRow])
    );
    const aiContext = {
      scopeType: "week",
      generatedAt: now.toUTC().toISO(),
      timezone,
      scopeDate: context.scopeDate,
      weekRange: {
        start: weekStart.toISODate(),
        end: weekEnd.toISODate(),
        label: weekLabel
      },
      planningSemantics: {
        note: "Тиждень оцінюється як набір окремих днів від понеділка до неділі. Беклог не вважається вже запланованою частиною тижня. planning_flexibility = essential означає, що задачу небажано рухати без потреби; flexible означає, що її легше посунути вручну.",
        suggestedPrimaryTaskId: nextAction?.id ?? null,
        suggestedDeferTaskId: deferCandidate?.id ?? null
      },
      weekTotals: {
        plannedCount: context.plannedCount,
        dueWithoutPlannedStartCount: context.dueWithoutPlannedStartCount,
        backlogCount: context.backlogCount,
        scheduledKnownEstimateMinutes: context.scheduledKnownEstimateMinutes,
        scheduledMissingEstimateCount: context.scheduledMissingEstimateCount
      },
      calendarWeek,
      worklogs: context.worklogs,
      weekDays: context.weekDays,
      notableDeadlines: context.notableDeadlines.slice(0, 8),
      tasks: {
        scheduledInWeek: context.scheduledInWeek.slice(0, 20),
        dueInWeekWithoutPlannedStart: context.dueInWeekWithoutPlannedStart.slice(0, 20),
        relevantBacklog: context.relevantBacklog.slice(0, 20)
      }
    };
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
          context: aiContext,
          taskLookup,
          fallback
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
      scopeType: "week",
      model: source === "ai" ? model : null,
      source,
      fallbackReason,
      contextSnapshot: {
        scopeType: "week",
        scopeDate: context.scopeDate,
        currentLocalTime: now.toISO(),
        quickCommunicationOpenCount: 0,
        plannedTodayCount: context.plannedCount,
        dueTodayWithoutPlannedStartCount: context.dueWithoutPlannedStartCount,
        backlogCount: context.backlogCount,
        overduePlannedCount: overloadedDays.length,
        scheduledKnownEstimateMinutes: context.scheduledKnownEstimateMinutes,
        scheduledMissingEstimateCount: context.scheduledMissingEstimateCount,
        protectedPendingCount: context.weekDays.reduce((sum, day) => sum + day.essentialScheduledCount, 0),
        recurringAtRiskCount: 0,
        calendarDay: calendarWeek,
        topMovedReasonsToday: [],
        dailyReview: {
          completedTodayCount: 0,
          movedTodayCount: 0,
          cancelledTodayCount: 0,
          protectedEssentialsMissedToday: 0
        },
        worklogs: context.worklogs,
        weekDays: context.weekDays,
        notableDeadlines: context.notableDeadlines
      },
      advisor
    } satisfies AdvisorResponse);
  }

  const dayStart = DateTime.fromISO(scopeDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const sevenDaysAgo = dayStart.minus({ days: 7 }).startOf("day");
  const isTodayScope = dayStart.hasSame(todayStart, "day");
  const scopeLabel = dayStart.toFormat("d LLLL");
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
    .filter((task) => isScheduledOverdue(task, overdueReference))
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
  const scheduledKnownEstimateMinutes = sumKnownEstimateMinutes(scheduledToday);
  const scheduledMissingEstimateCount = countMissingEstimates(scheduledToday);

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

  const topMovedReasonsToday = toRankedReasons(movedToday);
  const calendarDay = await buildCalendarDayContext(sessionUser.userId, timezone, dayStart, dayEnd);
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
  const deferCandidate = pickDeferCandidate(actionableTasks, timezone, dayStart, dayEnd, now);

  const aiContext = {
    generatedAt: now.toUTC().toISO(),
    timezone,
    scopeDate,
    currentLocalTime: now.toISO(),
    planningSemantics: {
      scheduledTodayCount: scheduledToday.length,
      dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
      backlogCount: backlog.length,
      overdueScheduledCount: overduePlanned.length,
      scheduledKnownEstimateMinutes,
      scheduledMissingEstimateCount,
      note: "Backlog визначається як scheduled_for IS NULL. Due-at без scheduled_for не вважається запланованим на цей день. Оцінки тривалості враховуються лише там, де вони реально заповнені. planning_flexibility = essential означає, що задачу краще не рухати без потреби; flexible означає, що її легше посунути вручну.",
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
    calendarDay: {
      connected: calendarDay.connected,
      available: calendarDay.available,
      eventCount: calendarDay.eventCount,
      busyMinutes: calendarDay.busyMinutes,
      extraEventCount: calendarDay.extraEventCount
    },
    dailyReview,
    worklogs: worklogSummary,
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
        estimatedMinutes: task.estimated_minutes,
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
        estimatedMinutes: task.estimated_minutes,
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
        estimatedMinutes: task.estimated_minutes,
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
        estimatedMinutes: task.estimated_minutes,
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
        estimatedMinutes: task.estimated_minutes,
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
        estimatedMinutes: task.estimated_minutes,
        dueAt: task.due_at,
        scheduledFor: task.scheduled_for
      }))
    }
  };

  const fallback = fallbackAdvisor({
    timezone,
    scopeDate,
    scopeLabel,
    isTodayScope,
    now,
    plannedTodayCount: scheduledToday.length,
    dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
    backlogCount: backlog.length,
    overduePlannedCount: overduePlanned.length,
    scheduledKnownEstimateMinutes,
    scheduledMissingEstimateCount,
    quickCommunicationOpenCount: quickCommunicationOpen.length,
    protectedPendingCount: protectedPending.length,
    recurringAtRiskCount: recurringAtRisk.length,
    topMovedReasonsToday,
    dailyReview,
    nextAction,
    deferCandidate,
    worklogs: worklogSummary
  });
  const taskLookup = new Map(tasks.map((task) => [task.id, task]));

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
        context: aiContext,
        taskLookup,
        fallback
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
    scopeType: "day",
    model: source === "ai" ? model : null,
    source,
    fallbackReason,
    contextSnapshot: {
      scopeType: "day",
      scopeDate,
      currentLocalTime: now.toISO(),
      quickCommunicationOpenCount: quickCommunicationOpen.length,
      plannedTodayCount: scheduledToday.length,
      dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
      backlogCount: backlog.length,
      overduePlannedCount: overduePlanned.length,
      scheduledKnownEstimateMinutes,
      scheduledMissingEstimateCount,
      protectedPendingCount: protectedPending.length,
      recurringAtRiskCount: recurringAtRisk.length,
      calendarDay: {
        connected: calendarDay.connected,
        available: calendarDay.available,
        eventCount: calendarDay.eventCount,
        busyMinutes: calendarDay.busyMinutes,
        extraEventCount: calendarDay.extraEventCount
      },
      topMovedReasonsToday,
      dailyReview,
      worklogs: worklogSummary,
      weekDays: [],
      notableDeadlines: []
    },
    advisor
  } satisfies AdvisorResponse);
});










