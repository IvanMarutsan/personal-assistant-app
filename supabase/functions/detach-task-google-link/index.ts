import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { detachTaskGoogleLink, loadTaskForGoogleSync } from "../_shared/task-google-sync.ts";

type DetachTaskGoogleLinkBody = {
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

  const body = await safeJson<DetachTaskGoogleLinkBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const task = await loadTaskForGoogleSync(supabase, sessionUser.userId, body.taskId);
  if (!task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  try {
    const result = await detachTaskGoogleLink(supabase, task);
    return jsonResponse({ ok: true, taskId: body.taskId, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_task_link_detach_failed";
    if (message === "google_task_link_not_found") {
      return jsonResponse({ ok: false, error: "google_task_link_not_found" }, 400);
    }
    console.error("[detach-task-google-link] failed", {
      taskId: body.taskId,
      userId: sessionUser.userId,
      error
    });
    return jsonResponse({ ok: false, error: "google_task_link_detach_failed", details: message }, 500);
  }
});
