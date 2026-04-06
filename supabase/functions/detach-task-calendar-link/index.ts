import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { detachTaskCalendarLink, loadTaskForCalendarSync } from "../_shared/task-calendar-sync.ts";

type DetachTaskCalendarLinkBody = {
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

  const body = await safeJson<DetachTaskCalendarLinkBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const task = await loadTaskForCalendarSync(supabase, sessionUser.userId, body.taskId);
  if (!task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  try {
    const result = await detachTaskCalendarLink(supabase, task);
    return jsonResponse({ ok: true, taskId: body.taskId, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "calendar_link_detach_failed";
    if (message === "calendar_link_not_found") {
      return jsonResponse({ ok: false, error: "calendar_link_not_found" }, 400);
    }
    if (message === "calendar_link_detach_not_allowed") {
      return jsonResponse({ ok: false, error: "calendar_link_detach_not_allowed" }, 400);
    }
    console.error("[detach-task-calendar-link] failed", {
      taskId: body.taskId,
      userId: sessionUser.userId,
      error
    });
    return jsonResponse({ ok: false, error: "calendar_link_detach_failed", details: message }, 500);
  }
});
