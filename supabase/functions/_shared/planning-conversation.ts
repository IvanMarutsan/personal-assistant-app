import { DateTime } from "npm:luxon@3.6.1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getGoogleAccessTokenForUser } from "./google-calendar.ts";

type TaskRow = {
  id: string;
  title: string;
  details: string | null;
  task_type:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday";
  status: "planned" | "in_progress" | "blocked" | "done" | "cancelled";
  importance: number;
  is_protected_essential: boolean;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_minutes: number | null;
  planning_flexibility: "essential" | "flexible" | null;
  project_id: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

type WorklogRow = {
  occurred_at: string;
  source: string | null;
  projects?: { name: string } | { name: string }[] | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  scope_type: "day" | "week";
  scope_date: string;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type ProposalRow = {
  id: string;
  session_id: string;
  assistant_message_id: string | null;
  task_id: string;
  proposal_type: "task_patch";
  payload: unknown;
  rationale: string | null;
  status: "proposed" | "applied" | "dismissed" | "superseded";
  created_at: string;
  updated_at: string;
};

type GoogleEvent = {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

export type PlanningScopeType = "day" | "week";
export type PlanningMessageRole = "user" | "assistant";
export type PlanningProposalStatus = "proposed" | "applied" | "dismissed" | "superseded";
export type PlanningProposalType = "task_patch";

export type TaskPatchPayload = {
  scheduled_for?: string | null;
  due_at?: string | null;
  estimated_minutes?: number | null;
};

export type PlanningCalendarEvent = {
  id: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
};

export type PlanningCalendarContext = {
  connected: boolean;
  available: boolean;
  eventCount: number;
  busyMinutes: number | null;
  events: PlanningCalendarEvent[];
  extraEventCount: number;
};

export type PlanningWorklogContext = {
  count: number;
  withoutProjectCount: number;
  topProjects: Array<{ name: string; count: number }>;
  sourceCounts: Array<{ source: string; count: number }>;
};

export type PlanningConversationTask = {
  id: string;
  title: string;
  details: string | null;
  taskType: TaskRow["task_type"];
  status: TaskRow["status"];
  importance: number;
  isProtectedEssential: boolean;
  projectId: string | null;
  projectName: string | null;
  dueAt: string | null;
  scheduledFor: string | null;
  estimatedMinutes: number | null;
  planningFlexibility: TaskRow["planning_flexibility"];
};

export type PlanningConversationSession = {
  id: string;
  scopeType: PlanningScopeType;
  scopeDate: string;
  status: SessionRow["status"];
  createdAt: string;
  updatedAt: string;
};

export type PlanningConversationMessage = {
  id: string;
  sessionId: string;
  role: PlanningMessageRole;
  content: string;
  createdAt: string;
};

export type PlanningConversationProposal = {
  id: string;
  sessionId: string;
  assistantMessageId: string | null;
  taskId: string;
  proposalType: PlanningProposalType;
  payload: TaskPatchPayload;
  rationale: string | null;
  status: PlanningProposalStatus;
  createdAt: string;
  updatedAt: string;
  task: PlanningConversationTask | null;
};

export type PlanningScopeDaySummary = {
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
};

export type PlanningDeadlineSummary = {
  taskId: string;
  title: string;
  projectName: string | null;
  dueAt: string;
};

export type PlanningScopeContext = {
  scopeType: PlanningScopeType;
  timezone: string;
  scopeDate: string;
  scopeStartIso: string;
  scopeEndIso: string;
  plannedCount: number;
  dueWithoutPlannedStartCount: number;
  backlogCount: number;
  scheduledKnownEstimateMinutes: number;
  scheduledMissingEstimateCount: number;
  calendar: PlanningCalendarContext;
  worklogs: PlanningWorklogContext;
  weekDays: PlanningScopeDaySummary[];
  notableDeadlines: PlanningDeadlineSummary[];
};

export type PlanningDayContext = PlanningScopeContext & {
  scopeType: "day";
  scheduledToday: PlanningConversationTask[];
  dueTodayWithoutPlannedStart: PlanningConversationTask[];
  relevantBacklog: PlanningConversationTask[];
};

export type PlanningWeekContext = PlanningScopeContext & {
  scopeType: "week";
  scheduledInWeek: PlanningConversationTask[];
  dueInWeekWithoutPlannedStart: PlanningConversationTask[];
  relevantBacklog: PlanningConversationTask[];
};

export type PlanningConversationContext = PlanningDayContext | PlanningWeekContext;

export type PlanningConversationState = {
  session: PlanningConversationSession;
  messages: PlanningConversationMessage[];
  proposals: PlanningConversationProposal[];
  latestAssistantMessageId: string | null;
  latestActionableAssistantMessageId: string | null;
  latestActionableProposalIds: string[];
  latestActionableProposalCount: number;
  scopeContext: PlanningScopeContext;
};

function projectName(task: TaskRow): string | null {
  if (!task.projects) return null;
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? null;
  return task.projects.name ?? null;
}

function worklogProjectName(worklog: WorklogRow): string | null {
  if (!worklog.projects) return null;
  if (Array.isArray(worklog.projects)) return worklog.projects[0]?.name ?? null;
  return worklog.projects.name ?? null;
}

function parseDate(value: string | null | undefined, zone: string): DateTime | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt : null;
}

function isSameRange(value: string | null | undefined, zone: string, start: DateTime, end: DateTime): boolean {
  const dt = parseDate(value, zone);
  return !!dt && dt >= start && dt <= end;
}

function sumKnownEstimateMinutes(tasks: PlanningConversationTask[]): number {
  return tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
}

function countMissingEstimates(tasks: PlanningConversationTask[]): number {
  return tasks.filter((task) => task.estimatedMinutes == null).length;
}

function toConversationTask(task: TaskRow): PlanningConversationTask {
  return {
    id: task.id,
    title: task.title,
    details: task.details,
    taskType: task.task_type,
    status: task.status,
    importance: task.importance,
    isProtectedEssential: task.is_protected_essential,
    projectId: task.project_id,
    projectName: projectName(task),
    dueAt: task.due_at,
    scheduledFor: task.scheduled_for,
    estimatedMinutes: task.estimated_minutes,
    planningFlexibility: task.planning_flexibility
  };
}

function toSession(row: SessionRow): PlanningConversationSession {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeDate: row.scope_date,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): PlanningConversationMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

function flexibilityPriority(value: PlanningConversationTask["planningFlexibility"]): number {
  if (value === "essential") return 0;
  if (value === "flexible") return 2;
  return 1;
}

function sortBacklog(a: PlanningConversationTask, b: PlanningConversationTask): number {
  if (a.isProtectedEssential !== b.isProtectedEssential) return a.isProtectedEssential ? -1 : 1;
  const flexibilityDelta = flexibilityPriority(a.planningFlexibility) - flexibilityPriority(b.planningFlexibility);
  if (flexibilityDelta !== 0) return flexibilityDelta;
  if (a.importance !== b.importance) return b.importance - a.importance;
  const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aDue !== bDue) return aDue - bDue;
  return a.title.localeCompare(b.title, "uk-UA");
}

function sortByDateField(tasks: PlanningConversationTask[], field: "scheduledFor" | "dueAt"): PlanningConversationTask[] {
  return [...tasks].sort((a, b) => {
    const aTime = a[field] ? new Date(a[field] as string).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b[field] ? new Date(b[field] as string).getTime() : Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return a.title.localeCompare(b.title, "uk-UA");
  });
}

function toCalendarEvent(event: GoogleEvent, timezone: string): PlanningCalendarEvent | null {
  const startRaw = event.start?.dateTime ?? event.start?.date ?? null;
  const endRaw = event.end?.dateTime ?? event.end?.date ?? null;
  const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);

  const startAt = startRaw
    ? (isAllDay
        ? DateTime.fromISO(startRaw, { zone: timezone }).startOf("day")
        : DateTime.fromISO(startRaw, { zone: "utc" }).setZone(timezone))
    : null;
  const endAt = endRaw
    ? (isAllDay
        ? DateTime.fromISO(endRaw, { zone: timezone }).startOf("day")
        : DateTime.fromISO(endRaw, { zone: "utc" }).setZone(timezone))
    : null;

  if (startAt && !startAt.isValid) return null;
  if (endAt && !endAt.isValid) return null;

  return {
    id: event.id,
    title: event.summary?.trim() || "(Без назви)",
    startAt: startAt?.toUTC().toISO() ?? null,
    endAt: endAt?.toUTC().toISO() ?? null,
    isAllDay
  };
}

export async function buildCalendarDayContext(
  userId: string,
  timezone: string,
  dayStart: DateTime,
  dayEnd: DateTime
): Promise<PlanningCalendarContext> {
  try {
    const auth = await getGoogleAccessTokenForUser(userId);
    const apiUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`
    );
    apiUrl.searchParams.set("timeMin", dayStart.toUTC().toISO() ?? new Date().toISOString());
    apiUrl.searchParams.set("timeMax", dayEnd.toUTC().toISO() ?? new Date().toISOString());
    apiUrl.searchParams.set("singleEvents", "true");
    apiUrl.searchParams.set("orderBy", "startTime");
    apiUrl.searchParams.set("maxResults", "20");

    const response = await fetch(apiUrl.toString(), {
      headers: { authorization: `Bearer ${auth.accessToken}` }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[planning-conversation] calendar_fetch_failed", {
        userId,
        status: response.status,
        text: text.slice(0, 240)
      });
      return {
        connected: true,
        available: false,
        eventCount: 0,
        busyMinutes: null,
        events: [],
        extraEventCount: 0
      };
    }

    const payload = (await response.json().catch(() => null)) as { items?: GoogleEvent[] } | null;
    const events = (payload?.items ?? [])
      .map((event) => toCalendarEvent(event, timezone))
      .filter((event): event is PlanningCalendarEvent => Boolean(event));

    const totalBusyMinutes = events.reduce((sum, event) => {
      if (!event.startAt || !event.endAt || event.isAllDay) return sum;
      const start = DateTime.fromISO(event.startAt, { zone: "utc" }).setZone(timezone);
      const end = DateTime.fromISO(event.endAt, { zone: "utc" }).setZone(timezone);
      if (!start.isValid || !end.isValid || end <= start) return sum;
      return sum + Math.round(end.diff(start, "minutes").minutes);
    }, 0);

    return {
      connected: true,
      available: true,
      eventCount: events.length,
      busyMinutes: totalBusyMinutes > 0 ? totalBusyMinutes : 0,
      events: events.slice(0, 8),
      extraEventCount: Math.max(0, events.length - 8)
    };
  } catch (error) {
    if (error instanceof Error && error.message === "calendar_not_connected") {
      return {
        connected: false,
        available: false,
        eventCount: 0,
        busyMinutes: null,
        events: [],
        extraEventCount: 0
      };
    }

    console.error("[planning-conversation] calendar_context_unavailable", {
      userId,
      error: error instanceof Error ? error.message : "unknown_error"
    });

    return {
      connected: true,
      available: false,
      eventCount: 0,
      busyMinutes: null,
      events: [],
      extraEventCount: 0
    };
  }
}

function summarizeWorklogs(worklogs: WorklogRow[]): PlanningWorklogContext {
  const projectCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  let withoutProjectCount = 0;

  for (const worklog of worklogs) {
    const project = worklogProjectName(worklog);
    if (project) {
      projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    } else {
      withoutProjectCount += 1;
    }

    const source = (worklog.source ?? "other").trim() || "other";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  return {
    count: worklogs.length,
    withoutProjectCount,
    topProjects: [...projectCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk-UA"))
      .slice(0, 3)
      .map(([name, count]) => ({ name, count })),
    sourceCounts: [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "uk-UA"))
      .map(([source, count]) => ({ source, count }))
  };
}

function aggregateCalendarContexts(days: PlanningCalendarContext[]): PlanningCalendarContext {
  const availableDays = days.filter((day) => day.available);
  return {
    connected: days.some((day) => day.connected),
    available: availableDays.length > 0,
    eventCount: days.reduce((sum, day) => sum + day.eventCount, 0),
    busyMinutes:
      availableDays.length > 0
        ? availableDays.reduce((sum, day) => sum + (day.busyMinutes ?? 0), 0)
        : null,
    events: [],
    extraEventCount: 0
  };
}

function buildWeekDaySummary(input: {
  scopeDate: string;
  scheduled: PlanningConversationTask[];
  dueWithoutSchedule: PlanningConversationTask[];
  calendar: PlanningCalendarContext;
  worklogs: WorklogRow[];
}): PlanningScopeDaySummary {
  return {
    scopeDate: input.scopeDate,
    plannedCount: input.scheduled.length,
    dueWithoutPlannedStartCount: input.dueWithoutSchedule.length,
    scheduledKnownEstimateMinutes: sumKnownEstimateMinutes(input.scheduled),
    scheduledMissingEstimateCount: countMissingEstimates(input.scheduled),
    calendarEventCount: input.calendar.eventCount,
    calendarBusyMinutes: input.calendar.busyMinutes,
    worklogCount: input.worklogs.length,
    essentialScheduledCount: input.scheduled.filter(
      (task) => task.isProtectedEssential || task.planningFlexibility === "essential"
    ).length,
    flexibleScheduledCount: input.scheduled.filter((task) => task.planningFlexibility === "flexible").length
  };
}

function buildNotableDeadlines(
  tasks: PlanningConversationTask[],
  timezone: string,
  start: DateTime,
  end: DateTime,
  limit: number
): PlanningDeadlineSummary[] {
  return tasks
    .filter((task) => isSameRange(task.dueAt, timezone, start, end))
    .sort((a, b) => {
      const aTime = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.title.localeCompare(b.title, "uk-UA");
    })
    .slice(0, limit)
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      projectName: task.projectName,
      dueAt: task.dueAt ?? start.toUTC().toISO() ?? new Date().toISOString()
    }));
}

async function loadOpenTasks(supabase: SupabaseClient, userId: string): Promise<PlanningConversationTask[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, details, task_type, status, importance, is_protected_essential, due_at, scheduled_for, estimated_minutes, planning_flexibility, project_id, projects(name)")
    .eq("user_id", userId)
    .neq("status", "done")
    .neq("status", "cancelled")
    .limit(500);

  if (error) throw error;
  return ((data ?? []) as TaskRow[]).map(toConversationTask);
}

async function loadWorklogsInRange(
  supabase: SupabaseClient,
  userId: string,
  rangeStartIso: string,
  rangeEndIso: string
): Promise<WorklogRow[]> {
  const { data, error } = await supabase
    .from("worklogs")
    .select("occurred_at, source, projects(name)")
    .eq("user_id", userId)
    .gte("occurred_at", rangeStartIso)
    .lte("occurred_at", rangeEndIso)
    .order("occurred_at", { ascending: false })
    .limit(400);

  if (error) {
    console.error("[planning-conversation] worklogs_range_failed", { userId, error: error.message });
    return [];
  }

  return (data ?? []) as WorklogRow[];
}

function filterWorklogsForDay(
  worklogs: WorklogRow[],
  timezone: string,
  dayStart: DateTime,
  dayEnd: DateTime
): WorklogRow[] {
  return worklogs.filter((worklog) => isSameRange(worklog.occurred_at, timezone, dayStart, dayEnd));
}

function startOfWeekScopeDate(scopeDate: string, timezone: string): string {
  const start = DateTime.fromISO(scopeDate, { zone: timezone }).startOf("day").startOf("week");
  return start.toISODate() ?? scopeDate;
}

export function validateScopeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function validateScopeType(value: string | null | undefined): PlanningScopeType | null {
  if (!value) return "day";
  return value === "day" || value === "week" ? value : null;
}

export function normalizeTaskPatchPayload(input: unknown): TaskPatchPayload | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const source = input as Record<string, unknown>;
  const result: TaskPatchPayload = {};

  if (Object.prototype.hasOwnProperty.call(source, "scheduled_for")) {
    const value = source.scheduled_for;
    if (value === null) {
      result.scheduled_for = null;
    } else if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return null;
      result.scheduled_for = parsed.toISOString();
    } else {
      return null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "due_at")) {
    const value = source.due_at;
    if (value === null) {
      result.due_at = null;
    } else if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return null;
      result.due_at = parsed.toISOString();
    } else {
      return null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "estimated_minutes")) {
    const value = source.estimated_minutes;
    if (value === null) {
      result.estimated_minutes = null;
    } else if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      result.estimated_minutes = value;
    } else {
      return null;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export async function getUserTimezone(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("timezone").eq("user_id", userId).maybeSingle();
  return (data?.timezone as string | undefined) || "UTC";
}

export async function normalizeScopeDateForType(
  supabase: SupabaseClient,
  userId: string,
  scopeType: PlanningScopeType,
  scopeDate: string
): Promise<string> {
  if (scopeType === "day") return scopeDate;
  const timezone = await getUserTimezone(supabase, userId);
  return startOfWeekScopeDate(scopeDate, timezone);
}

export async function ensurePlanningSession(
  supabase: SupabaseClient,
  userId: string,
  scopeType: PlanningScopeType,
  scopeDate: string
): Promise<PlanningConversationSession> {
  const { data, error } = await supabase
    .from("planning_sessions")
    .upsert(
      {
        user_id: userId,
        scope_type: scopeType,
        scope_date: scopeDate,
        status: "active"
      },
      {
        onConflict: "user_id,scope_type,scope_date",
        ignoreDuplicates: false
      }
    )
    .select("id, user_id, scope_type, scope_date, status, created_at, updated_at")
    .single();

  if (error || !data) {
    throw error ?? new Error("planning_session_create_failed");
  }

  return toSession(data as SessionRow);
}

export async function buildPlanningDayContext(
  supabase: SupabaseClient,
  userId: string,
  scopeDate: string
): Promise<PlanningDayContext> {
  const timezone = await getUserTimezone(supabase, userId);
  const tasks = await loadOpenTasks(supabase, userId);
  const dayStart = DateTime.fromISO(scopeDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const calendar = await buildCalendarDayContext(userId, timezone, dayStart, dayEnd);
  const worklogs = await loadWorklogsInRange(
    supabase,
    userId,
    dayStart.toUTC().toISO() ?? new Date().toISOString(),
    dayEnd.toUTC().toISO() ?? new Date().toISOString()
  );

  const scheduledToday = sortByDateField(
    tasks.filter((task) => isSameRange(task.scheduledFor, timezone, dayStart, dayEnd)),
    "scheduledFor"
  );
  const dueTodayWithoutPlannedStart = sortByDateField(
    tasks.filter((task) => !task.scheduledFor && isSameRange(task.dueAt, timezone, dayStart, dayEnd)),
    "dueAt"
  );
  const backlog = [...tasks].filter((task) => !task.scheduledFor).sort(sortBacklog);

  return {
    scopeType: "day",
    timezone,
    scopeDate,
    scopeStartIso: dayStart.toUTC().toISO() ?? new Date().toISOString(),
    scopeEndIso: dayEnd.toUTC().toISO() ?? new Date().toISOString(),
    plannedCount: scheduledToday.length,
    dueWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
    backlogCount: backlog.length,
    scheduledKnownEstimateMinutes: sumKnownEstimateMinutes(scheduledToday),
    scheduledMissingEstimateCount: countMissingEstimates(scheduledToday),
    calendar,
    worklogs: summarizeWorklogs(worklogs),
    weekDays: [],
    notableDeadlines: buildNotableDeadlines(tasks, timezone, dayStart, dayEnd, 8),
    scheduledToday: scheduledToday.slice(0, 14),
    dueTodayWithoutPlannedStart: dueTodayWithoutPlannedStart.slice(0, 12),
    relevantBacklog: backlog.slice(0, 16)
  };
}

export async function buildPlanningWeekContext(
  supabase: SupabaseClient,
  userId: string,
  scopeDate: string
): Promise<PlanningWeekContext> {
  const timezone = await getUserTimezone(supabase, userId);
  const normalizedScopeDate = startOfWeekScopeDate(scopeDate, timezone);
  const weekStart = DateTime.fromISO(normalizedScopeDate, { zone: timezone }).startOf("day");
  const weekEnd = weekStart.plus({ days: 6 }).endOf("day");
  const tasks = await loadOpenTasks(supabase, userId);
  const weekWorklogs = await loadWorklogsInRange(
    supabase,
    userId,
    weekStart.toUTC().toISO() ?? new Date().toISOString(),
    weekEnd.toUTC().toISO() ?? new Date().toISOString()
  );

  const weekDayData = await Promise.all(
    Array.from({ length: 7 }, async (_, index) => {
      const dayStart = weekStart.plus({ days: index }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const dayScopeDate = dayStart.toISODate() ?? normalizedScopeDate;
      const scheduled = sortByDateField(
        tasks.filter((task) => isSameRange(task.scheduledFor, timezone, dayStart, dayEnd)),
        "scheduledFor"
      );
      const dueWithoutSchedule = sortByDateField(
        tasks.filter((task) => !task.scheduledFor && isSameRange(task.dueAt, timezone, dayStart, dayEnd)),
        "dueAt"
      );
      const dayWorklogs = filterWorklogsForDay(weekWorklogs, timezone, dayStart, dayEnd);
      const calendar = await buildCalendarDayContext(userId, timezone, dayStart, dayEnd);

      return {
        scopeDate: dayScopeDate,
        scheduled,
        dueWithoutSchedule,
        dayWorklogs,
        calendar,
        summary: buildWeekDaySummary({
          scopeDate: dayScopeDate,
          scheduled,
          dueWithoutSchedule,
          calendar,
          worklogs: dayWorklogs
        })
      };
    })
  );

  const scheduledInWeek = sortByDateField(
    tasks.filter((task) => isSameRange(task.scheduledFor, timezone, weekStart, weekEnd)),
    "scheduledFor"
  );
  const dueInWeekWithoutPlannedStart = sortByDateField(
    tasks.filter((task) => !task.scheduledFor && isSameRange(task.dueAt, timezone, weekStart, weekEnd)),
    "dueAt"
  );
  const backlog = [...tasks].filter((task) => !task.scheduledFor).sort(sortBacklog);

  return {
    scopeType: "week",
    timezone,
    scopeDate: normalizedScopeDate,
    scopeStartIso: weekStart.toUTC().toISO() ?? new Date().toISOString(),
    scopeEndIso: weekEnd.toUTC().toISO() ?? new Date().toISOString(),
    plannedCount: scheduledInWeek.length,
    dueWithoutPlannedStartCount: dueInWeekWithoutPlannedStart.length,
    backlogCount: backlog.length,
    scheduledKnownEstimateMinutes: sumKnownEstimateMinutes(scheduledInWeek),
    scheduledMissingEstimateCount: countMissingEstimates(scheduledInWeek),
    calendar: aggregateCalendarContexts(weekDayData.map((item) => item.calendar)),
    worklogs: summarizeWorklogs(weekWorklogs),
    weekDays: weekDayData.map((item) => item.summary),
    notableDeadlines: buildNotableDeadlines(tasks, timezone, weekStart, weekEnd, 12),
    scheduledInWeek: scheduledInWeek.slice(0, 28),
    dueInWeekWithoutPlannedStart: dueInWeekWithoutPlannedStart.slice(0, 18),
    relevantBacklog: backlog.slice(0, 18)
  };
}

export async function buildPlanningContext(
  supabase: SupabaseClient,
  userId: string,
  scopeType: PlanningScopeType,
  scopeDate: string
): Promise<PlanningConversationContext> {
  if (scopeType === "week") {
    return await buildPlanningWeekContext(supabase, userId, scopeDate);
  }
  return await buildPlanningDayContext(supabase, userId, scopeDate);
}

export function getLatestActionableAssistantMessageId(
  proposals: Array<Pick<ProposalRow, "assistant_message_id" | "status" | "created_at">>
): string | null {
  const latest = [...proposals]
    .filter((proposal) => proposal.status === "proposed" && !!proposal.assistant_message_id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  return latest?.assistant_message_id ?? null;
}

export async function loadPlanningConversationState(
  supabase: SupabaseClient,
  userId: string,
  scopeType: PlanningScopeType,
  scopeDate: string
): Promise<PlanningConversationState> {
  const session = await ensurePlanningSession(supabase, userId, scopeType, scopeDate);
  const scopeContext = await buildPlanningContext(supabase, userId, scopeType, scopeDate);

  const { data: messagesData, error: messagesError } = await supabase
    .from("planning_messages")
    .select("id, session_id, role, content, created_at")
    .eq("session_id", session.id)
    .order("created_at", { ascending: true })
    .limit(100);

  if (messagesError) throw messagesError;

  const { data: proposalsData, error: proposalsError } = await supabase
    .from("planning_proposals")
    .select("id, session_id, assistant_message_id, task_id, proposal_type, payload, rationale, status, created_at, updated_at")
    .eq("session_id", session.id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (proposalsError) throw proposalsError;

  const proposalRows = (proposalsData ?? []) as ProposalRow[];
  const latestActionableAssistantMessageId = getLatestActionableAssistantMessageId(proposalRows);
  const latestActionableProposalIds = proposalRows
    .filter(
      (proposal) =>
        proposal.status === "proposed" &&
        proposal.assistant_message_id === latestActionableAssistantMessageId
    )
    .map((proposal) => proposal.id);
  const taskIds = [...new Set(proposalRows.map((proposal) => proposal.task_id))];
  const taskMap = new Map<string, PlanningConversationTask>();

  if (taskIds.length > 0) {
    const { data: tasksData, error: tasksError } = await supabase
      .from("tasks")
      .select("id, title, details, task_type, status, importance, is_protected_essential, due_at, scheduled_for, estimated_minutes, planning_flexibility, project_id, projects(name)")
      .eq("user_id", userId)
      .in("id", taskIds);

    if (tasksError) throw tasksError;
    ((tasksData ?? []) as TaskRow[]).forEach((task) => {
      taskMap.set(task.id, toConversationTask(task));
    });
  }

  const messages = ((messagesData ?? []) as MessageRow[]).map(toMessage);
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant") ?? null;

  return {
    session,
    messages,
    proposals: proposalRows.map((proposal) => ({
      id: proposal.id,
      sessionId: proposal.session_id,
      assistantMessageId: proposal.assistant_message_id,
      taskId: proposal.task_id,
      proposalType: proposal.proposal_type,
      payload: normalizeTaskPatchPayload(proposal.payload) ?? {},
      rationale: proposal.rationale,
      status: proposal.status,
      createdAt: proposal.created_at,
      updatedAt: proposal.updated_at,
      task: taskMap.get(proposal.task_id) ?? null
    })),
    latestAssistantMessageId: latestAssistantMessage?.id ?? null,
    latestActionableAssistantMessageId,
    latestActionableProposalIds,
    latestActionableProposalCount: latestActionableProposalIds.length,
    scopeContext: {
      scopeType: scopeContext.scopeType,
      timezone: scopeContext.timezone,
      scopeDate: scopeContext.scopeDate,
      scopeStartIso: scopeContext.scopeStartIso,
      scopeEndIso: scopeContext.scopeEndIso,
      plannedCount: scopeContext.plannedCount,
      dueWithoutPlannedStartCount: scopeContext.dueWithoutPlannedStartCount,
      backlogCount: scopeContext.backlogCount,
      scheduledKnownEstimateMinutes: scopeContext.scheduledKnownEstimateMinutes,
      scheduledMissingEstimateCount: scopeContext.scheduledMissingEstimateCount,
      calendar: scopeContext.calendar,
      worklogs: scopeContext.worklogs,
      weekDays: scopeContext.weekDays,
      notableDeadlines: scopeContext.notableDeadlines
    }
  };
}
