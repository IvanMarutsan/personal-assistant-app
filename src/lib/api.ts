import { appEnv } from "./env";
import type {
  AiAdvisorSummary,
  AppSession,
  GoogleCalendarEventItem,
  GoogleCalendarStatus,
  InboxItem,
  PlanningConversationState,
  PlanningFlexibility,
  MoveReasonCode,
  NoteItem,
  WorklogItem,
  PlanningSummary,
  ProjectItem,
  TaskItem,
  TaskType,
  TaskStatus,
  TriageAction
} from "../types/api";

type ErrorResponse = {
  ok: false;
  error?: string;
  message?: string;
};

export class ApiError extends Error {
  status: number;
  code: string | null;
  path: string;
  details: string | null;

  constructor(input: {
    message: string;
    status: number;
    code?: string | null;
    path: string;
    details?: string | null;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.path = input.path;
    this.details = input.details ?? null;
  }
}

function edgeUrl(path: string): string {
  return `${appEnv.edgeBaseUrl.replace(/\/$/, "")}/${path}`;
}

function sessionHeaders(sessionToken: string): Record<string, string> {
  return {
    "x-app-session": sessionToken,
    authorization: `Bearer ${sessionToken}`
  };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function resolveUserSafeMessage(status: number, code: string | null, fallback: string): string {
  if (status === 401 || code === "unauthorized" || code === "invalid_session") {
    return "Сесія недійсна або завершилась. Відкрий Інбокс і авторизуйся знову.";
  }
  if (status === 403 || code === "forbidden") {
    return "Недостатньо прав для цієї дії.";
  }
  return fallback;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(edgeUrl(path), {
      ...init,
      headers: {
        apikey: appEnv.supabaseAnonKey,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
  } catch (error) {
    console.error("[api] network_failure", { path, error });
    throw new ApiError({
      message: "Помилка мережі. Перевір з'єднання і спробуй ще раз.",
      status: 0,
      path,
      details: error instanceof Error ? error.message : "network_error"
    });
  }

  const body = (await parseBody(response)) as T | ErrorResponse | { message?: string };

  if (!response.ok) {
    const errorBody = body as ErrorResponse & { details?: string };
    const rawMessage = errorBody.message ?? errorBody.error ?? `Запит завершився помилкою (${response.status})`;
    const message = resolveUserSafeMessage(response.status, errorBody.error ?? null, rawMessage);
    console.error("[api] request_failed", {
      path,
      status: response.status,
      code: errorBody.error ?? null,
      message: errorBody.message ?? null,
      details: (body as { details?: string })?.details ?? null
    });
    throw new ApiError({
      message,
      status: response.status,
      code: errorBody.error ?? null,
      path,
      details: (body as { details?: string })?.details ?? null
    });
  }

  console.debug("[api] request_ok", { path, status: response.status });
  return body as T;
}

export function getTelegramInitDataRaw(): string {
  return window.Telegram?.WebApp?.initData?.trim() ?? "";
}

export async function authTelegram(initDataRaw: string): Promise<AppSession> {
  const result = await request<{
    ok: true;
    session: AppSession;
  }>("auth-telegram", {
    method: "POST",
    body: JSON.stringify({ initDataRaw })
  });

  return result.session;
}

export async function getInbox(sessionToken: string): Promise<InboxItem[]> {
  const result = await request<{
    ok: true;
    items: InboxItem[];
  }>("get-inbox", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function startGoogleCalendarConnect(input: {
  sessionToken: string;
  returnPath?: string;
}): Promise<{ authUrl: string }> {
  const result = await request<{
    ok: true;
    authUrl: string;
  }>("start-google-calendar-connect", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      returnPath: input.returnPath ?? "/calendar"
    })
  });

  return { authUrl: result.authUrl };
}

export async function getGoogleCalendarStatus(sessionToken: string): Promise<GoogleCalendarStatus> {
  const result = await request<{
    ok: true;
    connected: boolean;
    provider: "google";
    email: string | null;
    calendarId: string | null;
    expiresAt: string | null;
  }>("get-google-calendar-status", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return {
    connected: result.connected,
    provider: result.provider,
    email: result.email,
    calendarId: result.calendarId,
    expiresAt: result.expiresAt
  };
}

export async function getGoogleCalendarUpcoming(sessionToken: string): Promise<GoogleCalendarEventItem[]> {
  const result = await request<{
    ok: true;
    items: GoogleCalendarEventItem[];
  }>("get-google-calendar-upcoming", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function createGoogleCalendarEvent(input: {
  sessionToken: string;
  title: string;
  description?: string;
  startAt: string;
  endAt?: string | null;
  durationMinutes?: number;
  timezone?: string;
  sourceInboxItemId?: string;
  sourceTaskId?: string;
  sourceNoteId?: string;
}): Promise<{
  id: string;
  htmlLink: string | null;
  status: string | null;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
}> {
  const result = await request<{
    ok: true;
    event: {
      id: string;
      htmlLink: string | null;
      status: string | null;
      title: string;
      startAt: string;
      endAt: string;
      timezone: string;
    };
  }>("create-google-calendar-event", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      durationMinutes: input.durationMinutes ?? 30,
      timezone: input.timezone ?? "UTC",
      sourceInboxItemId: input.sourceInboxItemId,
      sourceTaskId: input.sourceTaskId,
      sourceNoteId: input.sourceNoteId
    })
  });

  return result.event;
}

export async function triageInboxItem(input: {
  sessionToken: string;
  inboxItemId: string;
  action: TriageAction;
  title?: string;
  details?: string;
  noteBody?: string;
  projectId?: string;
  taskType?: TaskType;
  importance?: number;
  dueAt?: string;
  scheduledFor?: string;
  estimatedMinutes?: number | null;
}): Promise<void> {
  await request<{ ok: true }>("triage-inbox-item", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      inboxItemId: input.inboxItemId,
      action: input.action,
      title: input.title,
      details: input.details,
      noteBody: input.noteBody,
      projectId: input.projectId,
      taskType: input.taskType,
      importance: input.importance,
      dueAt: input.dueAt,
      scheduledFor: input.scheduledFor,
      estimatedMinutes: input.estimatedMinutes ?? null
    })
  });
}

export async function resolveVoiceCandidate(input: {
  sessionToken: string;
  inboxItemId: string;
  candidateId: string;
  action: "task" | "note" | "worklog" | "calendar_event" | "discard";
  title?: string;
  details?: string;
  noteBody?: string;
  projectId?: string;
  taskType?: TaskType;
  importance?: number;
  dueAt?: string | null;
  scheduledFor?: string | null;
  estimatedMinutes?: number | null;
  timezone?: string;
}): Promise<{ allProcessed: boolean }> {
  const result = await request<{
    ok: true;
    allProcessed: boolean;
  }>("resolve-voice-candidate", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      inboxItemId: input.inboxItemId,
      candidateId: input.candidateId,
      action: input.action,
      title: input.title,
      details: input.details,
      noteBody: input.noteBody,
      projectId: input.projectId,
      taskType: input.taskType,
      importance: input.importance,
      dueAt: input.dueAt,
      scheduledFor: input.scheduledFor,
      estimatedMinutes: input.estimatedMinutes ?? null,
      timezone: input.timezone ?? "UTC"
    })
  });

  return { allProcessed: result.allProcessed };
}

export async function getProjects(sessionToken: string, options?: { includeArchived?: boolean }): Promise<ProjectItem[]> {
  const query = options?.includeArchived ? "?includeArchived=true" : "";
  const result = await request<{
    ok: true;
    items: ProjectItem[];
  }>(`get-projects${query}`, {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function createProject(input: {
  sessionToken: string;
  name: string;
}): Promise<ProjectItem> {
  const result = await request<{
    ok: true;
    item: ProjectItem;
  }>("create-project", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      name: input.name
    })
  });

  return result.item;
}

export async function updateProject(input: {
  sessionToken: string;
  projectId: string;
  name?: string;
  status?: "active" | "on_hold" | "archived";
  aliases?: string[];
}): Promise<ProjectItem> {
  const result = await request<{
    ok: true;
    item: ProjectItem;
  }>("update-project", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      projectId: input.projectId,
      name: input.name,
      status: input.status,
      aliases: input.aliases
    })
  });

  return result.item;
}

export async function getTasks(sessionToken: string): Promise<TaskItem[]> {
  const result = await request<{
    ok: true;
    items: TaskItem[];
  }>("get-tasks", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function getNotes(sessionToken: string): Promise<NoteItem[]> {
  const result = await request<{
    ok: true;
    items: NoteItem[];
  }>("get-notes", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function updateTaskStatus(input: {
  sessionToken: string;
  taskId: string;
  status: TaskStatus;
  reasonCode?: MoveReasonCode;
  reasonText?: string;
  rescheduleTo?: string;
  dueAt?: string;
  postponeMinutes?: number;
}): Promise<void> {
  await request<{ ok: true }>("update-task-status", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      taskId: input.taskId,
      status: input.status,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
      rescheduleTo: input.rescheduleTo,
      dueAt: input.dueAt,
      postponeMinutes: input.postponeMinutes
    })
  });
}

export async function updateTask(input: {
  sessionToken: string;
  taskId: string;
  title: string;
  details?: string | null;
  projectId?: string | null;
  taskType: TaskType;
  dueAt?: string | null;
  scheduledFor?: string | null;
  estimatedMinutes?: number | null;
  planningFlexibility?: PlanningFlexibility | null;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    taskId: input.taskId,
    title: input.title,
    details: input.details ?? null,
    taskType: input.taskType
  };

  if (input.projectId !== undefined) payload.projectId = input.projectId;
  if (input.dueAt !== undefined) payload.dueAt = input.dueAt;
  if (input.scheduledFor !== undefined) payload.scheduledFor = input.scheduledFor;
  if (input.estimatedMinutes !== undefined) payload.estimatedMinutes = input.estimatedMinutes;
  if (input.planningFlexibility !== undefined) payload.planningFlexibility = input.planningFlexibility;

  await request<{ ok: true }>("update-task", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify(payload)
  });
}

export async function getWorklogs(sessionToken: string): Promise<WorklogItem[]> {
  const result = await request<{
    ok: true;
    items: WorklogItem[];
  }>("get-worklogs", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
}

export async function createWorklog(input: {
  sessionToken: string;
  body: string;
  projectId?: string | null;
  occurredAt?: string | null;
  source?: string | null;
}): Promise<WorklogItem> {
  const result = await request<{
    ok: true;
    item: WorklogItem;
  }>("create-worklog", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      body: input.body,
      projectId: input.projectId ?? null,
      occurredAt: input.occurredAt ?? null,
      source: input.source ?? "manual"
    })
  });

  return result.item;
}

export async function updateNote(input: {
  sessionToken: string;
  noteId: string;
  title?: string | null;
  body?: string;
  convertToTask?: boolean;
  projectId?: string | null;
}): Promise<{ createdTaskId: string | null }> {
  const result = await request<{
    ok: true;
    noteId: string;
    createdTaskId: string | null;
  }>("update-note", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      noteId: input.noteId,
      title: input.title ?? null,
      body: input.body,
      convertToTask: input.convertToTask ?? false,
      projectId: input.projectId ?? null
    })
  });

  return { createdTaskId: result.createdTaskId };
}

export async function getPlanningAssistant(sessionToken: string, scopeDate?: string): Promise<PlanningSummary> {
  const path = scopeDate
    ? `get-planning-assistant?scopeDate=${encodeURIComponent(scopeDate)}`
    : "get-planning-assistant";

  const result = await request<{
    ok: true;
    generatedAt: string;
    timezone: string;
    rulesVersion: string;
    whatNow: PlanningSummary["whatNow"];
    overload: PlanningSummary["overload"];
    essentialRisk: PlanningSummary["essentialRisk"];
    dailyReview: PlanningSummary["dailyReview"];
    appliedThresholds: PlanningSummary["appliedThresholds"];
  }>(path, {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return {
    generatedAt: result.generatedAt,
    timezone: result.timezone,
    rulesVersion: result.rulesVersion,
    whatNow: result.whatNow,
    overload: result.overload,
    essentialRisk: result.essentialRisk,
    dailyReview: result.dailyReview,
    appliedThresholds: result.appliedThresholds
  };
}

export async function getAiAdvisor(sessionToken: string, scopeDate?: string): Promise<AiAdvisorSummary> {
  const path = scopeDate
    ? `get-ai-advisor?scopeDate=${encodeURIComponent(scopeDate)}`
    : "get-ai-advisor";

  const result = await request<{
    ok: true;
    generatedAt: string;
    timezone: string;
    model: string | null;
    source: AiAdvisorSummary["source"];
    fallbackReason: string | null;
    contextSnapshot: AiAdvisorSummary["contextSnapshot"];
    advisor: AiAdvisorSummary["advisor"];
  }>(path, {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return {
    generatedAt: result.generatedAt,
    timezone: result.timezone,
    model: result.model,
    source: result.source,
    fallbackReason: result.fallbackReason,
    contextSnapshot: result.contextSnapshot,
    advisor: result.advisor
  };
}








export async function transcribePlanningVoice(input: {
  sessionToken: string;
  file: File;
}): Promise<string> {
  const formData = new FormData();
  formData.append("file", input.file);

  let response: Response;
  try {
    response = await fetch(edgeUrl("transcribe-planning-voice"), {
      method: "POST",
      headers: {
        apikey: appEnv.supabaseAnonKey,
        ...sessionHeaders(input.sessionToken)
      },
      body: formData
    });
  } catch (error) {
    console.error("[api] network_failure", { path: "transcribe-planning-voice", error });
    throw new ApiError({
      message: "Помилка мережі. Перевір з'єднання і спробуй ще раз.",
      status: 0,
      path: "transcribe-planning-voice",
      details: error instanceof Error ? error.message : "network_error"
    });
  }

  const body = (await parseBody(response)) as
    | { ok: true; transcript: string }
    | (ErrorResponse & { details?: string })
    | { message?: string };

  if (!response.ok) {
    const errorBody = body as ErrorResponse & { details?: string };
    const rawMessage =
      errorBody.message ?? errorBody.error ?? `Запит завершився помилкою (${response.status})`;
    const message = resolveUserSafeMessage(response.status, errorBody.error ?? null, rawMessage);
    throw new ApiError({
      message,
      status: response.status,
      code: errorBody.error ?? null,
      path: "transcribe-planning-voice",
      details: errorBody.details ?? null
    });
  }

  return (body as { ok: true; transcript: string }).transcript;
}
export async function getPlanningConversation(input: {
  sessionToken: string;
  scopeDate: string;
}): Promise<PlanningConversationState> {
  return await request<PlanningConversationState & { ok: true }>(
    `get-planning-conversation?scopeDate=${encodeURIComponent(input.scopeDate)}`,
    {
      method: "GET",
      headers: sessionHeaders(input.sessionToken)
    }
  );
}

export async function sendPlanningConversationTurn(input: {
  sessionToken: string;
  scopeDate: string;
  sessionId: string;
  message: string;
}): Promise<PlanningConversationState> {
  return await request<PlanningConversationState & { ok: true }>("planning-conversation-turn", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      scopeDate: input.scopeDate,
      sessionId: input.sessionId,
      message: input.message
    })
  });
}

export async function updatePlanningProposal(input: {
  sessionToken: string;
  proposalId?: string;
  assistantMessageId?: string;
  action: "apply" | "dismiss" | "apply_all_latest" | "dismiss_all_latest";
}): Promise<PlanningConversationState> {
  return await request<PlanningConversationState & { ok: true }>("update-planning-proposal", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      proposalId: input.proposalId,
      assistantMessageId: input.assistantMessageId,
      action: input.action
    })
  });
}








