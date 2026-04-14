import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { loadTaskForGoogleSync, syncTaskGoogleAfterMutation } from "../_shared/task-google-sync.ts";

type RetryTaskGoogleSyncBody = {
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

  const body = await safeJson<RetryTaskGoogleSyncBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const task = await loadTaskForGoogleSync(supabase, sessionUser.userId, body.taskId);
  if (!task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const manualProtected =
    task.google_task_sync_mode === "manual" || (!!task.google_task_id && task.google_task_sync_mode !== "app_managed");
  if (manualProtected) {
    return jsonResponse({ ok: false, error: "google_task_sync_retry_not_allowed" }, 400);
  }

  if (task.status === "cancelled") {
    return jsonResponse({ ok: false, error: "google_task_sync_retry_not_needed" }, 400);
  }

  try {
    await syncTaskGoogleAfterMutation(supabase, sessionUser.userId, body.taskId, { forceCreate: true });
    return jsonResponse({ ok: true, taskId: body.taskId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_task_sync_failed";
    return jsonResponse({ ok: false, error: message, details: message }, 500);
  }
});
