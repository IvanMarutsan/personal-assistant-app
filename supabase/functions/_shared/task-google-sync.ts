import { createAdminClient } from "./db.ts";
import { getGoogleAccessTokenForUser, hasGoogleTasksScope, listGoogleTaskLists } from "./google-calendar.ts";

export type TaskGoogleSyncMode = "app_managed" | "manual";

export type TaskGoogleSyncRow = {
  id: string;
  user_id: string;
  title: string;
  details: string | null;
  status: string;
  due_at: string | null;
  scheduled_for: string | null;
  estimated_minutes: number | null;
  google_task_provider: string | null;
  google_task_list_id: string | null;
  google_task_id: string | null;
  google_task_sync_mode: TaskGoogleSyncMode | null;
  google_task_sync_error: string | null;
};

export type TaskGoogleInboundState =
  | {
      status: "manual" | "not_linked" | "healthy";
      message: string | null;
    }
  | {
      status: "changed";
      message: string;
      remoteTitle: string;
      remoteDetails: string | null;
      remoteDueAt: string | null;
      remoteStatus: "planned" | "done";
    }
  | {
      status: "missing";
      message: string;
    };

type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

type GoogleTaskPayload = {
  title: string;
  notes?: string | null;
  due?: string | null;
  status: "needsAction" | "completed";
  completed?: string | null;
};

type GoogleTaskSnapshot = {
  id: string;
  title: string;
  notes: string | null;
  due: string | null;
  status: "needsAction" | "completed";
  completed: string | null;
  deleted: boolean;
  hidden: boolean;
};

const DEFAULT_TASK_LIST_ID = "@default";

function normalizeNotes(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDueAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function googleTasksApiUrl(listId = DEFAULT_TASK_LIST_ID, taskId?: string): string {
  const base = `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`;
  return taskId ? `${base}/${encodeURIComponent(taskId)}` : base;
}

async function getGoogleTasksAccess(userId: string): Promise<{ accessToken: string; listId: string }> {
  try {
    const auth = await getGoogleAccessTokenForUser(userId);
    if (!hasGoogleTasksScope(auth.scope)) {
      throw new Error("google_tasks_scope_missing");
    }
    let listId = auth.defaultTaskListId || DEFAULT_TASK_LIST_ID;
    const availableTaskLists = await listGoogleTaskLists(userId);
    if (listId === DEFAULT_TASK_LIST_ID || !availableTaskLists.some((item) => item.id === listId)) {
      listId = availableTaskLists[0]?.id ?? DEFAULT_TASK_LIST_ID;
    }
    return { accessToken: auth.accessToken, listId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_tasks_access_failed";
    if (message === "calendar_not_connected") throw new Error("google_tasks_not_connected");
    if (message === "calendar_refresh_token_missing") throw new Error("google_tasks_auth_expired");
    if (message === "google_tasks_scope_missing") throw error;
    throw error;
  }
}

function buildGoogleTaskPayload(task: TaskGoogleSyncRow): GoogleTaskPayload {
  const isDone = task.status === "done";
  return {
    title: task.title.trim() || "Задача",
    notes: normalizeNotes(task.details),
    due: normalizeDueAt(task.due_at),
    status: isDone ? "completed" : "needsAction",
    completed: isDone ? new Date().toISOString() : null
  };
}

async function googleCreateTask(userId: string, payload: GoogleTaskPayload, listId = DEFAULT_TASK_LIST_ID): Promise<GoogleTaskSnapshot> {
  const auth = await getGoogleTasksAccess(userId);
  const response = await fetch(googleTasksApiUrl(listId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as Partial<GoogleTaskSnapshot> | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 403 ? "google_tasks_permission_denied" : `google_task_create_failed_${response.status}`);
  }

  return {
    id: body.id,
    title: body.title ?? payload.title,
    notes: body.notes ?? payload.notes ?? null,
    due: body.due ?? payload.due ?? null,
    status: (body.status as GoogleTaskSnapshot["status"] | undefined) ?? payload.status,
    completed: body.completed ?? payload.completed ?? null,
    deleted: false,
    hidden: false
  };
}

async function googleUpdateTask(userId: string, listId: string, taskId: string, payload: GoogleTaskPayload): Promise<GoogleTaskSnapshot> {
  const auth = await getGoogleTasksAccess(userId);
  const response = await fetch(googleTasksApiUrl(listId, taskId), {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = (await response.json().catch(() => null)) as Partial<GoogleTaskSnapshot> | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "google_task_not_found" : response.status === 403 ? "google_tasks_permission_denied" : `google_task_update_failed_${response.status}`);
  }

  return {
    id: body.id,
    title: body.title ?? payload.title,
    notes: body.notes ?? payload.notes ?? null,
    due: body.due ?? payload.due ?? null,
    status: (body.status as GoogleTaskSnapshot["status"] | undefined) ?? payload.status,
    completed: body.completed ?? payload.completed ?? null,
    deleted: Boolean(body.deleted),
    hidden: Boolean(body.hidden)
  };
}

async function googleGetTask(userId: string, listId: string, taskId: string): Promise<GoogleTaskSnapshot> {
  const auth = await getGoogleTasksAccess(userId);
  const response = await fetch(googleTasksApiUrl(listId, taskId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${auth.accessToken}`
    }
  });

  const body = (await response.json().catch(() => null)) as Partial<GoogleTaskSnapshot> | null;
  if (!response.ok || !body?.id) {
    throw new Error(response.status === 404 ? "google_task_not_found" : response.status === 403 ? "google_tasks_permission_denied" : `google_task_fetch_failed_${response.status}`);
  }

  return {
    id: body.id,
    title: body.title ?? "",
    notes: body.notes ?? null,
    due: body.due ?? null,
    status: body.status === "completed" ? "completed" : "needsAction",
    completed: body.completed ?? null,
    deleted: Boolean(body.deleted),
    hidden: Boolean(body.hidden)
  };
}

async function googleDeleteTask(userId: string, listId: string, taskId: string): Promise<void> {
  const auth = await getGoogleTasksAccess(userId);
  const response = await fetch(googleTasksApiUrl(listId, taskId), {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${auth.accessToken}`
    }
  });

  if (response.ok || response.status === 404) return;
  throw new Error(response.status === 403 ? "google_tasks_permission_denied" : `google_task_delete_failed_${response.status}`);
}

async function updateTaskGoogleFields(
  supabase: SupabaseAdminClient,
  taskId: string,
  userId: string,
  patch: Partial<
    Pick<
      TaskGoogleSyncRow,
      "google_task_provider" | "google_task_list_id" | "google_task_id" | "google_task_sync_mode" | "google_task_sync_error"
    >
  >
): Promise<void> {
  const { error } = await supabase.from("tasks").update(patch).eq("id", taskId).eq("user_id", userId);
  if (error) throw error;
}

export async function loadTaskForGoogleSync(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskGoogleSyncRow | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, user_id, title, details, status, due_at, scheduled_for, estimated_minutes, google_task_provider, google_task_list_id, google_task_id, google_task_sync_mode, google_task_sync_error"
    )
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return (data as TaskGoogleSyncRow | null) ?? null;
}

export async function syncTaskGoogleAfterMutation(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string,
  options?: { forceCreate?: boolean }
): Promise<void> {
  const task = await loadTaskForGoogleSync(supabase, userId, taskId);
  if (!task) throw new Error("task_not_found");

  const manualProtected =
    task.google_task_sync_mode === "manual" || (!!task.google_task_id && task.google_task_sync_mode !== "app_managed");
  if (manualProtected) return;

  const hasManagedLink =
    task.google_task_sync_mode === "app_managed" &&
    task.google_task_provider === "google_tasks" &&
    !!task.google_task_id &&
    !!task.google_task_list_id;

  if (task.status === "cancelled") {
    if (hasManagedLink) {
      await googleDeleteTask(userId, task.google_task_list_id!, task.google_task_id!);
      await updateTaskGoogleFields(supabase, task.id, userId, {
        google_task_provider: null,
        google_task_list_id: null,
        google_task_id: null,
        google_task_sync_mode: null,
        google_task_sync_error: null
      });
    }
    return;
  }

  if (!hasManagedLink && !options?.forceCreate) {
    if (task.google_task_sync_error) {
      await updateTaskGoogleFields(supabase, task.id, userId, { google_task_sync_error: null });
    }
    return;
  }

  try {
    const payload = buildGoogleTaskPayload(task);
    const targetListId = hasManagedLink ? task.google_task_list_id! : (await getGoogleTasksAccess(userId)).listId;
    const result = hasManagedLink
      ? await googleUpdateTask(userId, task.google_task_list_id!, task.google_task_id!, payload)
      : await googleCreateTask(userId, payload, targetListId);

    await updateTaskGoogleFields(supabase, task.id, userId, {
      google_task_provider: "google_tasks",
      google_task_list_id: hasManagedLink ? task.google_task_list_id! : targetListId,
      google_task_id: result.id,
      google_task_sync_mode: "app_managed",
      google_task_sync_error: null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_task_sync_failed";
    await updateTaskGoogleFields(supabase, task.id, userId, {
      google_task_sync_mode: task.google_task_sync_mode ?? "app_managed",
      google_task_sync_error: message
    });
    throw error;
  }
}

export async function cleanupDeletedTaskGoogleSync(supabase: SupabaseAdminClient, task: TaskGoogleSyncRow): Promise<void> {
  const hasManagedLink =
    task.google_task_sync_mode === "app_managed" &&
    task.google_task_provider === "google_tasks" &&
    !!task.google_task_id &&
    !!task.google_task_list_id;
  if (!hasManagedLink) return;
  await googleDeleteTask(task.user_id, task.google_task_list_id!, task.google_task_id!);
}

export async function inspectTaskInboundGoogleChange(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskGoogleInboundState> {
  const task = await loadTaskForGoogleSync(supabase, userId, taskId);
  if (!task) throw new Error("task_not_found");

  const manualProtected =
    task.google_task_sync_mode === "manual" || (!!task.google_task_id && task.google_task_sync_mode !== "app_managed");
  if (manualProtected) {
    return { status: "manual", message: "Google Tasks прив'язано вручну." };
  }
  if (!task.google_task_id || !task.google_task_list_id || task.google_task_provider !== "google_tasks") {
    return { status: "not_linked", message: "Зв'язку з Google Tasks зараз немає." };
  }

  try {
    const remote = await googleGetTask(userId, task.google_task_list_id, task.google_task_id);
    if (remote.deleted || remote.hidden) {
      return { status: "missing", message: "Задачу в Google Tasks більше не знайдено." };
    }

    const remoteStatus = remote.status === "completed" ? "done" : "planned";
    const remoteTitle = remote.title.trim();
    const remoteDetails = normalizeNotes(remote.notes);
    const remoteDueAt = normalizeDueAt(remote.due);

    const changed =
      remoteTitle !== task.title.trim() ||
      remoteDetails !== normalizeNotes(task.details) ||
      remoteDueAt !== normalizeDueAt(task.due_at) ||
      remoteStatus !== (task.status === "done" ? "done" : "planned");

    if (!changed) {
      return { status: "healthy", message: null };
    }

    return {
      status: "changed",
      message: "У Google Tasks є зміни, які можна застосувати до задачі.",
      remoteTitle,
      remoteDetails,
      remoteDueAt,
      remoteStatus
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_task_fetch_failed";
    if (message === "google_task_not_found") {
      return { status: "missing", message: "Задачу в Google Tasks більше не знайдено." };
    }
    throw error;
  }
}

export async function applyTaskInboundGoogleChange(
  supabase: SupabaseAdminClient,
  userId: string,
  taskId: string
): Promise<TaskGoogleInboundState> {
  const state = await inspectTaskInboundGoogleChange(supabase, userId, taskId);
  if (state.status !== "changed") return state;

  const { error } = await supabase
    .from("tasks")
    .update({
      title: state.remoteTitle.slice(0, 120),
      details: state.remoteDetails,
      due_at: state.remoteDueAt,
      status: state.remoteStatus,
      google_task_sync_error: null
    })
    .eq("id", taskId)
    .eq("user_id", userId);

  if (error) throw error;

  return {
    status: "healthy",
    message: "Зміни з Google Tasks застосовано."
  };
}

export async function detachTaskGoogleLink(
  supabase: SupabaseAdminClient,
  task: TaskGoogleSyncRow
): Promise<{ removedRemote: boolean }> {
  if (!task.google_task_id || !task.google_task_list_id || task.google_task_provider !== "google_tasks") {
    throw new Error("google_task_link_not_found");
  }

  const managed = task.google_task_sync_mode === "app_managed";
  if (managed) {
    await googleDeleteTask(task.user_id, task.google_task_list_id, task.google_task_id);
  }

  await updateTaskGoogleFields(supabase, task.id, task.user_id, {
    google_task_provider: null,
    google_task_list_id: null,
    google_task_id: null,
    google_task_sync_mode: null,
    google_task_sync_error: null
  });

  return { removedRemote: managed };
}
