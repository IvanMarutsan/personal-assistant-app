import { appEnv } from "./env";
import type {
  AiAdvisorSummary,
  AppSession,
  InboxItem,
  MoveReasonCode,
  NoteItem,
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
    const rawMessage = errorBody.message ?? errorBody.error ?? `Request failed (${response.status})`;
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
      scheduledFor: input.scheduledFor
    })
  });
}

export async function getProjects(sessionToken: string): Promise<ProjectItem[]> {
  const result = await request<{
    ok: true;
    items: ProjectItem[];
  }>("get-projects", {
    method: "GET",
    headers: sessionHeaders(sessionToken)
  });

  return result.items;
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

export async function getPlanningAssistant(sessionToken: string): Promise<PlanningSummary> {
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
  }>("get-planning-assistant", {
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

export async function getAiAdvisor(sessionToken: string): Promise<AiAdvisorSummary> {
  const result = await request<{
    ok: true;
    generatedAt: string;
    timezone: string;
    model: string | null;
    source: AiAdvisorSummary["source"];
    fallbackReason: string | null;
    contextSnapshot: AiAdvisorSummary["contextSnapshot"];
    advisor: AiAdvisorSummary["advisor"];
  }>("get-ai-advisor", {
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
