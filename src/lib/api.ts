import { appEnv } from "./env";
import type {
  AiAdvisorSummary,
  AppSession,
  InboxItem,
  MoveReasonCode,
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

function edgeUrl(path: string): string {
  return `${appEnv.edgeBaseUrl.replace(/\/$/, "")}/${path}`;
}

async function parseJson(response: Response) {
  return (await response.json()) as unknown;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(edgeUrl(path), {
    ...init,
    headers: {
      apikey: appEnv.supabaseAnonKey,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const body = (await parseJson(response)) as T | ErrorResponse;

  if (!response.ok) {
    const errorBody = body as ErrorResponse;
    throw new Error(errorBody.message ?? errorBody.error ?? `Request failed (${response.status})`);
  }

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
    headers: {
      "x-app-session": sessionToken
    }
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
    headers: {
      "x-app-session": input.sessionToken
    },
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
    headers: {
      "x-app-session": sessionToken
    }
  });

  return result.items;
}

export async function getTasks(sessionToken: string): Promise<TaskItem[]> {
  const result = await request<{
    ok: true;
    items: TaskItem[];
  }>("get-tasks", {
    method: "GET",
    headers: {
      "x-app-session": sessionToken
    }
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
    headers: {
      "x-app-session": input.sessionToken
    },
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
    headers: {
      "x-app-session": sessionToken
    }
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
    headers: {
      "x-app-session": sessionToken
    }
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
