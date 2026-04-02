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
  protectedPending: TaskRow[],
  highImportanceToday: TaskRow[]
): TaskRow | null {
  const first = overdue[0] ?? hardToday[0] ?? protectedPending[0] ?? highImportanceToday[0];
  return first ?? null;
}

function pickDeferCandidate(actionableTasks: TaskRow[]): TaskRow | null {
  const deferable = actionableTasks.filter(
    (task) =>
      task.task_type === "quick_communication" ||
      task.task_type === "admin_operational" ||
      task.task_type === "someday"
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
      ? `Focus on "${input.nextAction.title}" first.`
      : "No urgent focus item found; pick one planned task and complete it end-to-end.",
    suggestedNextAction: {
      taskId: input.nextAction?.id ?? null,
      title: input.nextAction?.title ?? "Start one planned task",
      reason:
        input.overduePlannedCount > 0
          ? "There are overdue planned tasks; pulling one forward prevents compounding backlog."
          : "This is the highest-priority actionable item from current deterministic signals."
    },
    suggestedDefer: {
      taskId: input.deferCandidate?.id ?? null,
      title: input.deferCandidate?.title ?? "No clear defer candidate",
      reason: input.deferCandidate
        ? "This item has lower strategic urgency relative to overdue/hard/protected work."
        : "Keep the current plan and avoid adding more scope."
    },
    protectedEssentialsWarning: {
      hasWarning: warningActive,
      message: warningActive
        ? "Protected or recurring essentials are at risk of being squeezed out today."
        : "No immediate protected-essential squeeze-out signal detected."
    },
    explanation: `As of ${input.now.toFormat("HH:mm")} (${input.timezone}), there are ${input.plannedTodayCount} planned tasks for today, ${input.overduePlannedCount} overdue planned tasks, and ${input.quickCommunicationOpenCount} open quick communication tasks.`,
    evidence: [
      `planned_today=${input.plannedTodayCount}`,
      `overdue_planned=${input.overduePlannedCount}`,
      `protected_pending=${input.protectedPendingCount}`,
      `recurring_at_risk=${input.recurringAtRiskCount}`,
      `quick_communication_open=${input.quickCommunicationOpenCount}`,
      `top_moved_reasons_today=${JSON.stringify(input.topMovedReasonsToday)}`,
      `daily_review=${JSON.stringify(input.dailyReview)}`
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
          "You are a read-only planning advisor for a personal execution app. Never suggest automatic task mutations. Use only the provided context. Be concise, deterministic, and practical."
      },
      {
        role: "user",
        content: `Return strict JSON only with keys: whatMattersMostNow, suggestedNextAction, suggestedDefer, protectedEssentialsWarning, explanation, evidence. Context: ${JSON.stringify(
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
  const overduePlanned = actionableTasks
    .filter((task) => isOverdue(task, now))
    .sort((a, b) => (taskTime(a, timezone)?.toMillis() ?? 0) - (taskTime(b, timezone)?.toMillis() ?? 0));
  const plannedToday = actionableTasks.filter((task) =>
    isSameDay(taskTime(task, timezone), dayStart, dayEnd)
  );
  const hardToday = plannedToday.filter((task) => task.commitment_type === "hard");
  const highImportanceToday = plannedToday.filter(
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
      (task) => task.status !== "done" && !isSameDay(taskTime(task, timezone), dayStart, dayEnd)
    ).length
  };

  const topMovedReasonsToday = toRankedReasons(movedToday);
  const topMovedReasonsLast7d = toRankedReasons(
    recentEvents.filter((event) => event.event_type === "postponed" || event.event_type === "rescheduled")
  );

  const nextAction = pickNextAction(overduePlanned, hardToday, protectedPending, highImportanceToday);
  const deferCandidate = pickDeferCandidate(actionableTasks);

  const aiContext = {
    generatedAt: now.toUTC().toISO(),
    timezone,
    currentLocalTime: now.toISO(),
    deterministicBaseline: {
      priorityOrder: [
        "overdue_planned",
        "hard_commitment_today",
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
      plannedToday: plannedToday.slice(0, 15).map((task) => ({
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
    plannedTodayCount: plannedToday.length,
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
      plannedTodayCount: plannedToday.length,
      overduePlannedCount: overduePlanned.length,
      protectedPendingCount: protectedPending.length,
      recurringAtRiskCount: recurringAtRisk.length,
      topMovedReasonsToday,
      dailyReview
    },
    advisor
  } satisfies AdvisorResponse);
});
