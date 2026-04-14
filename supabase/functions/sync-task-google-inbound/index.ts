import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { applyTaskInboundGoogleChange, inspectTaskInboundGoogleChange, loadTaskForGoogleSync } from "../_shared/task-google-sync.ts";

type SyncTaskGoogleInboundBody = {
  taskId?: string;
  action?: "inspect" | "apply";
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

  const body = await safeJson<SyncTaskGoogleInboundBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const action = body.action ?? "inspect";
  const supabase = createAdminClient();
  const task = await loadTaskForGoogleSync(supabase, sessionUser.userId, body.taskId);
  if (!task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  try {
    const state =
      action === "apply"
        ? await applyTaskInboundGoogleChange(supabase, sessionUser.userId, body.taskId)
        : await inspectTaskInboundGoogleChange(supabase, sessionUser.userId, body.taskId);

    return jsonResponse({ ok: true, taskId: body.taskId, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_task_inbound_sync_failed";
    console.error("[sync-task-google-inbound] failed", {
      taskId: body.taskId,
      userId: sessionUser.userId,
      action,
      error
    });
    return jsonResponse({ ok: false, error: "google_task_inbound_sync_failed", details: message }, 500);
  }
});
