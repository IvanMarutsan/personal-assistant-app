import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskCalendarAfterMutation } from "../_shared/task-calendar-sync.ts";

type RetryTaskCalendarSyncBody = {
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

  const body = await safeJson<RetryTaskCalendarSyncBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const { data: task, error } = await supabase
    .from("tasks")
    .select("id, user_id, status, scheduled_for, calendar_provider, calendar_event_id, calendar_sync_mode")
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (error || !task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const manualProtected =
    task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");

  if (manualProtected) {
    return jsonResponse({ ok: false, error: "calendar_sync_retry_not_allowed" }, 400);
  }

  const recoverableManagedLink =
    task.calendar_sync_mode === "app_managed" &&
    task.calendar_provider === "google" &&
    !!task.calendar_event_id;

  if (!task.scheduled_for && !recoverableManagedLink) {
    return jsonResponse({ ok: false, error: "calendar_sync_retry_not_needed" }, 400);
  }

  await syncTaskCalendarAfterMutation(supabase, sessionUser.userId, body.taskId);

  return jsonResponse({ ok: true, taskId: body.taskId });
});
