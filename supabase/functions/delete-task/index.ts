import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { cleanupDeletedTaskCalendarSync, type TaskCalendarSyncRow } from "../_shared/task-calendar-sync.ts";
import { cleanupDeletedTaskGoogleSync, type TaskGoogleSyncRow } from "../_shared/task-google-sync.ts";

type DeleteTaskBody = {
  taskId?: string;
};

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const sessionUser = await resolveSessionUser(req);
  if (!sessionUser) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await safeJson<DeleteTaskBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select(
      "id, user_id, title, details, due_at, scheduled_for, estimated_minutes, calendar_provider, calendar_provider_calendar_id, calendar_event_id, calendar_sync_mode, calendar_sync_error, google_task_provider, google_task_list_id, google_task_id, google_task_sync_mode, google_task_sync_error, status"
    )
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (taskError || !task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  await cleanupDeletedTaskCalendarSync(supabase, task as TaskCalendarSyncRow);
  await cleanupDeletedTaskGoogleSync(supabase, task as TaskGoogleSyncRow);

  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId);

  if (error) {
    return jsonResponse({ ok: false, error: "task_delete_failed", message: error.message }, 500);
  }

  return jsonResponse({ ok: true, taskId: body.taskId });
});
