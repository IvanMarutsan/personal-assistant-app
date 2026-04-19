import { appEnv } from "./env";
import type {
  AiAdvisorSummary,
  AppSession,
  CalendarBlockItem,
  GoogleCalendarListItem,
  GoogleCalendarEventItem,
  GoogleIntegrationPreferences,
  GoogleCalendarStatus,
  GoogleTaskListItem,
  InboxItem,
  PlanningConversationState,
  PlanningConversationScopeType,
  PlanningFlexibility,
  CreateTaskResult,
  RecurrenceFrequency,
  MoveReasonCode,
  NoteItem,
  WorklogItem,
  PlanningSummary,
  ProjectItem,
  TaskCalendarInboundState,
  TaskGoogleImportResult,
  TaskGoogleInboundState,
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
function resolveUserSafeMessage(status: number, code: string | null, fallback: string, path?: string): string {
  if (status === 401 || code === "unauthorized" || code === "invalid_session") {
    return "\u0421\u0435\u0441\u0456\u044f \u043d\u0435\u0434\u0456\u0439\u0441\u043d\u0430 \u0430\u0431\u043e \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043b\u0430\u0441\u044c. \u0412\u0456\u0434\u043a\u0440\u0438\u0439 \u0406\u043d\u0431\u043e\u043a\u0441 \u0456 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0443\u0439\u0441\u044f \u0437\u043d\u043e\u0432\u0443.";
  }
  if (status === 403 || code === "forbidden") {
    return "\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043d\u044c\u043e \u043f\u0440\u0430\u0432 \u0434\u043b\u044f \u0446\u0456\u0454\u0457 \u0434\u0456\u0457.";
  }
  if (status === 404 && path && ["get-calendar-blocks", "upsert-calendar-block", "delete-calendar-block"].includes(path)) {
    return "\u0424\u0443\u043d\u043a\u0446\u0456\u0457 \u0431\u043b\u043e\u043a\u0456\u0432 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044f \u0449\u0435 \u043d\u0435 \u0432\u0438\u043a\u043b\u0430\u0434\u0435\u043d\u0456 \u043d\u0430 backend. \u041f\u043e\u0442\u0440\u0456\u0431\u0435\u043d deploy \u0444\u0443\u043d\u043a\u0446\u0456\u0439 \u0456 \u043c\u0456\u0433\u0440\u0430\u0446\u0456\u0457.";
  }
  if (code === "calendar_not_connected") {
    return "Google Calendar \u0449\u0435 \u043d\u0435 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043e.";
  }
  if (code === "selected_calendars_required") {
    return "Потрібно залишити хоча б один видимий календар.";
  }
  if (code === "invalid_selected_calendar" || code === "invalid_default_calendar") {
    return "Вибрано календар, який зараз недоступний у Google.";
  }
  if (code === "invalid_default_task_list") {
    return "Вибраний список Google Tasks зараз недоступний.";
  }
  if (code === "google_tasks_not_connected") {
    return "Google Tasks ще не підключено. Перепідключи Google акаунт у вкладці «Календар».";
  }
  if (code === "google_tasks_scope_missing") {
    return "Для Google Tasks потрібен оновлений дозвіл Google. Перепідключи Google акаунт.";
  }
  if (code === "google_tasks_auth_expired") {
    return "Доступ до Google Tasks завершився. Перепідключи Google акаунт.";
  }
  if (code === "google_tasks_api_disabled") {
    return "Google Tasks API недоступний для цього підключення. Це вже схоже на проблему в Google Cloud / Google API налаштуваннях.";
  }
  if (code === "google_tasks_insufficient_permissions") {
    return "Google не дав достатніх прав для Google Tasks. Спробуй перепідключити акаунт ще раз.";
  }
  if (code === "google_tasks_permission_denied") {
    return "Немає доступу до Google Tasks. Google Calendar може бути підключений окремо, але Tasks API зараз відхиляє доступ.";
  }
  if (code === "google_task_link_not_found") {
    return "Зв'язок із Google Tasks уже відсутній.";
  }
  if (code === "calendar_auth_expired") {
    return "\u0414\u043e\u0441\u0442\u0443\u043f \u0434\u043e Google Calendar \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044f. \u041f\u0435\u0440\u0435\u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0438 \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440.";
  }
  if (code === "calendar_permission_denied") {
    return "\u041d\u0435\u043c\u0430\u0454 \u0434\u043e\u0441\u0442\u0443\u043f\u0443 \u0434\u043e Google Calendar. \u041f\u0435\u0440\u0435\u0432\u0456\u0440 \u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043d\u044f.";
  }
  if (code === "calendar_invalid_request" || code === "invalid_time_range") {
    return "\u041f\u0435\u0440\u0435\u0432\u0456\u0440 \u0447\u0430\u0441 \u043f\u043e\u0447\u0430\u0442\u043a\u0443 \u0439 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043d\u044f \u0431\u043b\u043e\u043a\u0443.";
  }
  if (code === "missing_title") {
    return "\u0414\u043b\u044f \u0431\u043b\u043e\u043a\u0443 \u043f\u043e\u0442\u0440\u0456\u0431\u043d\u0430 \u043d\u0430\u0437\u0432\u0430.";
  }
  if (code === "invalid_recurrence_frequency") {
    return "Поки що повторення підтримує лише щоденний, щотижневий або щомісячний режим.";
  }
  if (code === "recurrence_requires_anchor") {
    return "Для повторення потрібен дедлайн або планований старт.";
  }
  if (code === "project_not_found") {
    return "\u0412\u043a\u0430\u0437\u0430\u043d\u0438\u0439 \u043f\u0440\u043e\u0454\u043a\u0442 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e.";
  }
  if (code === "calendar_block_not_found") {
    return "\u0426\u0435\u0439 \u0431\u043b\u043e\u043a \u0443\u0436\u0435 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e.";
  }
  if (code === "calendar_block_all_day_read_only") {
    return "\u041f\u043e\u0434\u0456\u0457 \u043d\u0430 \u0432\u0435\u0441\u044c \u0434\u0435\u043d\u044c \u043f\u043e\u043a\u0438 \u0449\u043e \u043c\u043e\u0436\u043d\u0430 \u0440\u0435\u0434\u0430\u0433\u0443\u0432\u0430\u0442\u0438 \u0442\u0456\u043b\u044c\u043a\u0438 \u0432 Google Calendar.";
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
    const message = resolveUserSafeMessage(response.status, errorBody.error ?? null, rawMessage, path);
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
    selectedCalendarIds: string[];
    defaultCalendarId: string | null;
    defaultTaskListId: string | null;
    tasksScopeAvailable: boolean;
    tasksAccessState?: "usable" | "scope_missing" | "permission_denied" | "auth_expired" | "not_connected" | "unknown";
    tasksAccessError?: string | null;
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
    selectedCalendarIds: result.selectedCalendarIds ?? [],
    defaultCalendarId: result.defaultCalendarId ?? null,
    defaultTaskListId: result.defaultTaskListId ?? null,
    tasksScopeAvailable: Boolean(result.tasksScopeAvailable),
    tasksAccessState: result.tasksAccessState ?? "not_connected",
    tasksAccessError: result.tasksAccessError ?? null,
    expiresAt: result.expiresAt
  };
}

export async function getGoogleIntegrationPreferences(sessionToken: string): Promise<GoogleIntegrationPreferences> {
  const result = await request<{
    ok: true;
    connected: boolean;
    calendars: GoogleCalendarListItem[];
    taskLists: GoogleTaskListItem[];
    selectedCalendarIds: string[];
    defaultCalendarId: string | null;
    defaultTaskListId: string | null;
    tasksScopeAvailable: boolean;
    tasksAccessState?: "usable" | "scope_missing" | "permission_denied" | "auth_expired" | "not_connected" | "unknown";
    tasksAccessError?: string | null;
  }>("get-google-integration-preferences", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return {
    connected: result.connected,
    calendars: result.calendars ?? [],
    taskLists: result.taskLists ?? [],
    selectedCalendarIds: result.selectedCalendarIds ?? [],
    defaultCalendarId: result.defaultCalendarId ?? null,
    defaultTaskListId: result.defaultTaskListId ?? null,
    tasksScopeAvailable: Boolean(result.tasksScopeAvailable),
    tasksAccessState: result.tasksAccessState ?? "not_connected",
    tasksAccessError: result.tasksAccessError ?? null
  };
}

export async function updateGoogleIntegrationPreferences(input: {
  sessionToken: string;
  selectedCalendarIds: string[];
  defaultCalendarId: string | null;
  defaultTaskListId?: string | null;
}): Promise<{
  selectedCalendarIds: string[];
  defaultCalendarId: string | null;
  defaultTaskListId: string | null;
}> {
  const result = await request<{
    ok: true;
    preferences: {
      selectedCalendarIds: string[];
      defaultCalendarId: string | null;
      defaultTaskListId: string | null;
    };
  }>("update-google-integration-preferences", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      selectedCalendarIds: input.selectedCalendarIds,
      defaultCalendarId: input.defaultCalendarId,
      defaultTaskListId: input.defaultTaskListId ?? null
    })
  });

  return result.preferences;
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

export async function getCalendarBlocks(input: {
  sessionToken: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<CalendarBlockItem[]> {
  const url = new URL(edgeUrl("get-calendar-blocks"));
  url.searchParams.set("timeMin", input.timeMin);
  url.searchParams.set("timeMax", input.timeMax);
  if (input.maxResults) url.searchParams.set("maxResults", String(input.maxResults));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: appEnv.supabaseAnonKey,
        ...sessionHeaders(input.sessionToken)
      }
    });
  } catch (error) {
    throw new ApiError({
      message: "\u041f\u043e\u043c\u0438\u043b\u043a\u0430 \u043c\u0435\u0440\u0435\u0436\u0456. \u041f\u0435\u0440\u0435\u0432\u0456\u0440 \u0437\u0027\u0454\u0434\u043d\u0430\u043d\u043d\u044f \u0456 \u0441\u043f\u0440\u043e\u0431\u0443\u0439 \u0449\u0435 \u0440\u0430\u0437.",
      status: 0,
      path: "get-calendar-blocks",
      details: error instanceof Error ? error.message : "network_error"
    });
  }

  const body = (await parseBody(response)) as { ok?: boolean; items?: CalendarBlockItem[]; error?: string; message?: string; details?: string } | null;
  if (!response.ok) {
    throw new ApiError({
      message: resolveUserSafeMessage(response.status, body?.error ?? null, body?.message ?? body?.error ?? `\u0417\u0430\u043f\u0438\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044f \u043f\u043e\u043c\u0438\u043b\u043a\u043e\u044e (${response.status})`, "get-calendar-blocks"),
      status: response.status,
      code: body?.error ?? null,
      path: "get-calendar-blocks",
      details: body?.details ?? null
    });
  }

  return body?.items ?? [];
}

export async function upsertCalendarBlock(input: {
  sessionToken: string;
  id?: string | null;
  title: string;
  details?: string | null;
  startAt: string;
  endAt: string;
  timezone?: string | null;
  projectId?: string | null;
  recurrenceFrequency?: RecurrenceFrequency | null;
}): Promise<CalendarBlockItem> {
  const result = await request<{ ok: true; block: CalendarBlockItem }>("upsert-calendar-block", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      id: input.id ?? null,
      title: input.title,
      details: input.details ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      timezone: input.timezone ?? null,
      projectId: input.projectId ?? null,
      recurrenceFrequency: input.recurrenceFrequency ?? null
    })
  });
  return result.block;
}

export async function deleteCalendarBlock(input: { sessionToken: string; id: string }): Promise<void> {
  await request<{ ok: true }>("delete-calendar-block", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ id: input.id })
  });
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

export async function createTask(input: {
  sessionToken: string;
  title: string;
  details?: string | null;
  projectId?: string | null;
  taskType?: TaskType;
  dueAt?: string | null;
  scheduledFor?: string | null;
  estimatedMinutes?: number | null;
  planningFlexibility?: PlanningFlexibility | null;
  recurrenceFrequency?: RecurrenceFrequency | null;
}): Promise<CreateTaskResult> {
  const result = await request<{
    ok: true;
    taskId: string;
    googleTaskSyncError?: string | null;
    linkedGoogleTask?: boolean;
    googleTaskSyncState?: "linked" | "not_linked" | "sync_unavailable";
  }>("create-task", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      title: input.title,
      details: input.details ?? null,
      projectId: input.projectId ?? null,
      taskType: input.taskType ?? "admin",
      dueAt: input.dueAt ?? null,
      scheduledFor: input.scheduledFor ?? null,
      estimatedMinutes: input.estimatedMinutes ?? null,
      planningFlexibility: input.planningFlexibility ?? null,
      recurrenceFrequency: input.recurrenceFrequency ?? null
    })
  });

  return {
    taskId: result.taskId,
    googleTaskSyncError: result.googleTaskSyncError ?? null,
    linkedGoogleTask: Boolean(result.linkedGoogleTask),
    googleTaskSyncState: result.googleTaskSyncState ?? (result.googleTaskSyncError ? "sync_unavailable" : result.linkedGoogleTask ? "linked" : "not_linked")
  };
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
  recurrenceFrequency?: RecurrenceFrequency | null;
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
  if (input.recurrenceFrequency !== undefined) payload.recurrenceFrequency = input.recurrenceFrequency;

  await request<{ ok: true }>("update-task", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify(payload)
  });
}

export async function deleteTask(input: {
  sessionToken: string;
  taskId: string;
}): Promise<void> {
  await request<{ ok: true }>("delete-task", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId })
  });
}

export async function retryTaskCalendarSync(input: {
  sessionToken: string;
  taskId: string;
}): Promise<void> {
  await request<{ ok: true }>("retry-task-calendar-sync", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId })
  });
}

export async function detachTaskCalendarLink(input: {
  sessionToken: string;
  taskId: string;
}): Promise<void> {
  await request<{ ok: true }>("detach-task-calendar-link", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId })
  });
}

export async function retryTaskGoogleSync(input: {
  sessionToken: string;
  taskId: string;
}): Promise<void> {
  await request<{ ok: true }>("retry-task-google-sync", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId })
  });
}

export async function detachTaskGoogleLink(input: {
  sessionToken: string;
  taskId: string;
}): Promise<void> {
  await request<{ ok: true }>("detach-task-google-link", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId })
  });
}

export async function inspectTaskGoogleInbound(input: {
  sessionToken: string;
  taskId: string;
}): Promise<TaskGoogleInboundState> {
  const result = await request<{
    ok: true;
    taskId: string;
    state: TaskGoogleInboundState;
  }>("sync-task-google-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId, action: "inspect" })
  });

  return result.state;
}

export async function applyTaskGoogleInbound(input: {
  sessionToken: string;
  taskId: string;
}): Promise<TaskGoogleInboundState> {
  const result = await request<{
    ok: true;
    taskId: string;
    state: TaskGoogleInboundState;
  }>("sync-task-google-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId, action: "apply" })
  });

  return result.state;
}
export async function importGoogleTasksInbound(input: {
  sessionToken: string;
}): Promise<TaskGoogleImportResult> {
  const result = await request<{
    ok: true;
    action: "import_visible";
    result: TaskGoogleImportResult;
  }>("sync-task-google-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ action: "import_visible" })
  });

  return result.result;
}
export async function inspectTaskCalendarInbound(input: {
  sessionToken: string;
  taskId: string;
}): Promise<TaskCalendarInboundState> {
  const result = await request<{
    ok: true;
    taskId: string;
    state: TaskCalendarInboundState;
  }>("sync-task-calendar-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId, action: "inspect" })
  });

  return result.state;
}

export async function applyTaskCalendarInbound(input: {
  sessionToken: string;
  taskId: string;
}): Promise<TaskCalendarInboundState> {
  const result = await request<{
    ok: true;
    taskId: string;
    state: TaskCalendarInboundState;
  }>("sync-task-calendar-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId, action: "apply" })
  });

  return result.state;
}
export async function keepTaskCalendarLocalVersion(input: {
  sessionToken: string;
  taskId: string;
}): Promise<TaskCalendarInboundState> {
  const result = await request<{
    ok: true;
    taskId: string;
    state: TaskCalendarInboundState;
  }>("sync-task-calendar-inbound", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ taskId: input.taskId, action: "keep_local" })
  });

  return result.state;
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

export async function deleteWorklog(input: {
  sessionToken: string;
  worklogId: string;
}): Promise<void> {
  await request<{ ok: true }>("delete-worklog", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ worklogId: input.worklogId })
  });
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

export async function createNote(input: {
  sessionToken: string;
  title?: string | null;
  body: string;
  projectId?: string | null;
}): Promise<{ noteId: string }> {
  const result = await request<{
    ok: true;
    noteId: string;
  }>("create-note", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      title: input.title ?? null,
      body: input.body,
      projectId: input.projectId ?? null
    })
  });

  return { noteId: result.noteId };
}

export async function deleteNote(input: {
  sessionToken: string;
  noteId: string;
}): Promise<void> {
  await request<{ ok: true }>("delete-note", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({ noteId: input.noteId })
  });
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

function normalizePlanningSummary(input: PlanningSummary): PlanningSummary {
  return {
    ...input,
    overload: {
      ...input.overload,
      taskTypeSignals: Array.isArray(input.overload?.taskTypeSignals) ? input.overload.taskTypeSignals : [],
      flags: Array.isArray(input.overload?.flags) ? input.overload.flags : []
    },
    essentialRisk: {
      protectedEssentialRisk: Array.isArray(input.essentialRisk?.protectedEssentialRisk) ? input.essentialRisk.protectedEssentialRisk : [],
      recurringEssentialRisk: Array.isArray(input.essentialRisk?.recurringEssentialRisk) ? input.essentialRisk.recurringEssentialRisk : [],
      squeezedOutRisk: Array.isArray(input.essentialRisk?.squeezedOutRisk) ? input.essentialRisk.squeezedOutRisk : []
    },
    dailyReview: {
      ...input.dailyReview,
      topMovedReasons: Array.isArray(input.dailyReview?.topMovedReasons) ? input.dailyReview.topMovedReasons : [],
      worklogs: {
        ...input.dailyReview.worklogs,
        topProjects: Array.isArray(input.dailyReview?.worklogs?.topProjects) ? input.dailyReview.worklogs.topProjects : [],
        sourceCounts: Array.isArray(input.dailyReview?.worklogs?.sourceCounts) ? input.dailyReview.worklogs.sourceCounts : []
      }
    },
    weeklyReview: input.weeklyReview
      ? {
          done: Array.isArray(input.weeklyReview.done) ? input.weeklyReview.done : [],
          notDone: Array.isArray(input.weeklyReview.notDone) ? input.weeklyReview.notDone : [],
          moved: Array.isArray(input.weeklyReview.moved) ? input.weeklyReview.moved : [],
          shouldMove: Array.isArray(input.weeklyReview.shouldMove) ? input.weeklyReview.shouldMove : [],
          shouldKill: Array.isArray(input.weeklyReview.shouldKill) ? input.weeklyReview.shouldKill : []
        }
      : null,
    weekDays: Array.isArray(input.weekDays) ? input.weekDays : [],
    notableDeadlines: Array.isArray(input.notableDeadlines) ? input.notableDeadlines : []
  };
}

function normalizeAiAdvisorSummary(input: AiAdvisorSummary): AiAdvisorSummary {
  return {
    ...input,
    contextSnapshot: {
      ...input.contextSnapshot,
      taskTypeSignals: Array.isArray(input.contextSnapshot?.taskTypeSignals) ? input.contextSnapshot.taskTypeSignals : [],
      topMovedReasonsToday: Array.isArray(input.contextSnapshot?.topMovedReasonsToday) ? input.contextSnapshot.topMovedReasonsToday : [],
      worklogs: {
        ...input.contextSnapshot.worklogs,
        topProjects: Array.isArray(input.contextSnapshot?.worklogs?.topProjects) ? input.contextSnapshot.worklogs.topProjects : [],
        sourceCounts: Array.isArray(input.contextSnapshot?.worklogs?.sourceCounts) ? input.contextSnapshot.worklogs.sourceCounts : []
      },
      weekDays: Array.isArray(input.contextSnapshot.weekDays) ? input.contextSnapshot.weekDays : [],
      notableDeadlines: Array.isArray(input.contextSnapshot.notableDeadlines) ? input.contextSnapshot.notableDeadlines : []
    },
    advisor: {
      ...input.advisor,
      evidence: Array.isArray(input.advisor?.evidence) ? input.advisor.evidence : []
    }
  };
}

export async function getPlanningAssistant(
  sessionToken: string,
  scopeDate?: string,
  scopeType: "day" | "week" = "day"
): Promise<PlanningSummary> {
  const params = new URLSearchParams();
  if (scopeDate) params.set("scopeDate", scopeDate);
  if (scopeType !== "day") params.set("scopeType", scopeType);
  const path = params.size > 0 ? `get-planning-assistant?${params.toString()}` : "get-planning-assistant";

  const result = await request<{
    ok: true;
    generatedAt: string;
    timezone: string;
    scopeType: PlanningSummary["scopeType"];
    scopeDate: string;
    rulesVersion: string;
    whatNow: PlanningSummary["whatNow"];
    overload: PlanningSummary["overload"];
    essentialRisk: PlanningSummary["essentialRisk"];
    dailyReview: PlanningSummary["dailyReview"];
    weeklyReview: PlanningSummary["weeklyReview"];
    weekDays: PlanningSummary["weekDays"];
    notableDeadlines: PlanningSummary["notableDeadlines"];
    appliedThresholds: PlanningSummary["appliedThresholds"];
  }>(path, {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return normalizePlanningSummary({
    generatedAt: result.generatedAt,
    timezone: result.timezone,
    scopeType: result.scopeType,
    scopeDate: result.scopeDate,
    rulesVersion: result.rulesVersion,
    whatNow: result.whatNow,
    overload: result.overload,
    essentialRisk: result.essentialRisk,
    dailyReview: result.dailyReview,
    weeklyReview: result.weeklyReview,
    weekDays: result.weekDays,
    notableDeadlines: result.notableDeadlines,
    appliedThresholds: result.appliedThresholds
  });
}

export async function getAiAdvisor(
  sessionToken: string,
  scopeDate?: string,
  scopeType: "day" | "week" = "day"
): Promise<AiAdvisorSummary> {
  const params = new URLSearchParams();
  if (scopeDate) params.set("scopeDate", scopeDate);
  if (scopeType !== "day") params.set("scopeType", scopeType);
  const path = params.size > 0 ? `get-ai-advisor?${params.toString()}` : "get-ai-advisor";

  const result = await request<{
    ok: true;
    generatedAt: string;
    timezone: string;
    scopeType: AiAdvisorSummary["scopeType"];
    model: string | null;
    source: AiAdvisorSummary["source"];
    fallbackReason: string | null;
    contextSnapshot: AiAdvisorSummary["contextSnapshot"];
    advisor: AiAdvisorSummary["advisor"];
  }>(path, {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return normalizeAiAdvisorSummary({
    generatedAt: result.generatedAt,
    timezone: result.timezone,
    scopeType: result.scopeType,
    model: result.model,
    source: result.source,
    fallbackReason: result.fallbackReason,
    contextSnapshot: result.contextSnapshot,
    advisor: result.advisor
  });
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
  scopeType?: PlanningConversationScopeType;
  scopeDate: string;
}): Promise<PlanningConversationState> {
  const scopeType = input.scopeType ?? "day";
  return await request<PlanningConversationState & { ok: true }>(
    `get-planning-conversation?scopeType=${encodeURIComponent(scopeType)}&scopeDate=${encodeURIComponent(input.scopeDate)}`,
    {
      method: "GET",
      headers: sessionHeaders(input.sessionToken)
    }
  );
}

export async function sendPlanningConversationTurn(input: {
  sessionToken: string;
  scopeType?: PlanningConversationScopeType;
  scopeDate: string;
  sessionId: string;
  message: string;
}): Promise<PlanningConversationState> {
  return await request<PlanningConversationState & { ok: true }>("planning-conversation-turn", {
    method: "POST",
    headers: sessionHeaders(input.sessionToken),
    body: JSON.stringify({
      scopeType: input.scopeType ?? "day",
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



















