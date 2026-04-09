import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import {
  applyTaskInboundCalendarChange,
  inspectTaskInboundCalendarChange,
  keepTaskLocalCalendarVersion,
  loadTaskForCalendarSync
} from "../_shared/task-calendar-sync.ts";

type SyncTaskCalendarInboundBody = {
  taskId?: string;
  action?: "inspect" | "apply" | "keep_local";
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

  const body = await safeJson<SyncTaskCalendarInboundBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const action = body.action ?? "inspect";
  const supabase = createAdminClient();
  const task = await loadTaskForCalendarSync(supabase, sessionUser.userId, body.taskId);
  if (!task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const manualProtected =
    task.calendar_sync_mode === "manual" || (!!task.calendar_event_id && task.calendar_sync_mode !== "app_managed");

  if (manualProtected) {
    return jsonResponse({
      ok: true,
      taskId: body.taskId,
      state: {
        status: "manual",
        message: "Подію прив’язано вручну."
      }
    });
  }

  try {
    const state = action === "apply"
      ? await applyTaskInboundCalendarChange(supabase, sessionUser.userId, body.taskId)
      : action === "keep_local"
        ? await keepTaskLocalCalendarVersion(supabase, sessionUser.userId, body.taskId)
        : await inspectTaskInboundCalendarChange(supabase, sessionUser.userId, body.taskId);

    return jsonResponse({ ok: true, taskId: body.taskId, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "calendar_inbound_sync_failed";
    if (message === "task_not_found") {
      return jsonResponse({ ok: false, error: "task_not_found" }, 404);
    }
    console.error("[sync-task-calendar-inbound] failed", {
      taskId: body.taskId,
      userId: sessionUser.userId,
      action,
      error
    });
    return jsonResponse({ ok: false, error: "calendar_inbound_sync_failed", details: message }, 500);
  }
});
