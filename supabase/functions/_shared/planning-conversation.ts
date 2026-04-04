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

type SessionRow = {
  id: string;
  user_id: string;
  scope_type: "day";
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

export type PlanningScopeType = "day";
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

export type PlanningDayContext = {
  timezone: string;
  scopeDate: string;
  dayStartIso: string;
  dayEndIso: string;
  plannedTodayCount: number;
  dueTodayWithoutPlannedStartCount: number;
  backlogCount: number;
  scheduledKnownEstimateMinutes: number;
  scheduledMissingEstimateCount: number;
  calendar: PlanningCalendarContext;
  scheduledToday: PlanningConversationTask[];
  dueTodayWithoutPlannedStart: PlanningConversationTask[];
  relevantBacklog: PlanningConversationTask[];
};

export type PlanningConversationState = {
  session: PlanningConversationSession;
  messages: PlanningConversationMessage[];
  proposals: PlanningConversationProposal[];
  latestAssistantMessageId: string | null;
  latestActionableAssistantMessageId: string | null;
  latestActionableProposalIds: string[];
  latestActionableProposalCount: number;
  dayContext: Omit<PlanningDayContext, "scheduledToday" | "dueTodayWithoutPlannedStart" | "relevantBacklog">;
};

function projectName(task: TaskRow): string | null {
  if (!task.projects) return null;
  if (Array.isArray(task.projects)) return task.projects[0]?.name ?? null;
  return task.projects.name ?? null;
}

function parseDate(value: string | null | undefined, zone: string): DateTime | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: "utc" }).setZone(zone);
  return dt.isValid ? dt : null;
}

function isSameDay(value: string | null | undefined, zone: string, start: DateTime, end: DateTime): boolean {
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

export function validateScopeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
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

export async function ensurePlanningSession(
  supabase: SupabaseClient,
  userId: string,
  scopeDate: string
): Promise<PlanningConversationSession> {
  const { data, error } = await supabase
    .from("planning_sessions")
    .upsert(
      {
        user_id: userId,
        scope_type: "day",
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
  const dayStart = DateTime.fromISO(scopeDate, { zone: timezone }).startOf("day");
  const dayEnd = dayStart.endOf("day");

  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, details, task_type, status, importance, is_protected_essential, due_at, scheduled_for, estimated_minutes, planning_flexibility, project_id, projects(name)")
    .eq("user_id", userId)
    .neq("status", "done")
    .neq("status", "cancelled")
    .limit(500);

  if (error) throw error;

  const tasks = ((data ?? []) as TaskRow[]).map(toConversationTask);
  const scheduledToday = tasks
    .filter((task) => isSameDay(task.scheduledFor, timezone, dayStart, dayEnd))
    .sort((a, b) => {
      const aTime = a.scheduledFor ? new Date(a.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.scheduledFor ? new Date(b.scheduledFor).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.title.localeCompare(b.title, "uk-UA");
    });
  const dueTodayWithoutPlannedStart = tasks
    .filter((task) => !task.scheduledFor && isSameDay(task.dueAt, timezone, dayStart, dayEnd))
    .sort((a, b) => {
      const aTime = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (aTime !== bTime) return aTime - bTime;
      return a.title.localeCompare(b.title, "uk-UA");
    });
  const backlog = tasks.filter((task) => !task.scheduledFor).sort(sortBacklog);
  const calendar = await buildCalendarDayContext(userId, timezone, dayStart, dayEnd);

  return {
    timezone,
    scopeDate,
    dayStartIso: dayStart.toUTC().toISO() ?? new Date().toISOString(),
    dayEndIso: dayEnd.toUTC().toISO() ?? new Date().toISOString(),
    plannedTodayCount: scheduledToday.length,
    dueTodayWithoutPlannedStartCount: dueTodayWithoutPlannedStart.length,
    backlogCount: backlog.length,
    scheduledKnownEstimateMinutes: sumKnownEstimateMinutes(scheduledToday),
    scheduledMissingEstimateCount: countMissingEstimates(scheduledToday),
    calendar,
    scheduledToday: scheduledToday.slice(0, 14),
    dueTodayWithoutPlannedStart: dueTodayWithoutPlannedStart.slice(0, 12),
    relevantBacklog: backlog.slice(0, 16)
  };
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
  scopeDate: string
): Promise<PlanningConversationState> {
  const session = await ensurePlanningSession(supabase, userId, scopeDate);
  const dayContext = await buildPlanningDayContext(supabase, userId, scopeDate);

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
    dayContext: {
      timezone: dayContext.timezone,
      scopeDate: dayContext.scopeDate,
      dayStartIso: dayContext.dayStartIso,
      dayEndIso: dayContext.dayEndIso,
      plannedTodayCount: dayContext.plannedTodayCount,
      dueTodayWithoutPlannedStartCount: dayContext.dueTodayWithoutPlannedStartCount,
      backlogCount: dayContext.backlogCount,
      scheduledKnownEstimateMinutes: dayContext.scheduledKnownEstimateMinutes,
      scheduledMissingEstimateCount: dayContext.scheduledMissingEstimateCount,
      calendar: dayContext.calendar
    }
  };
}
