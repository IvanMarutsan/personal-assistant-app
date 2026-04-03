import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const sessionUser = await resolveSessionUser(req);
  if (!sessionUser) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, title, details, task_type, status, last_moved_reason, project_id, due_at, scheduled_for, is_protected_essential, projects(name)"
    )
    .eq("user_id", sessionUser.userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return jsonResponse({ ok: false, error: "tasks_fetch_failed" }, 500);
  }

  const taskIds = (data ?? []).map((item) => item.id);
  const cancelReasonByTaskId = new Map<string, string | null>();

  if (taskIds.length > 0) {
    const { data: cancelEvents } = await supabase
      .from("task_events")
      .select("task_id, reason_text, created_at")
      .eq("user_id", sessionUser.userId)
      .eq("event_type", "status_changed")
      .eq("new_status", "cancelled")
      .in("task_id", taskIds)
      .order("created_at", { ascending: false });

    for (const event of cancelEvents ?? []) {
      if (!cancelReasonByTaskId.has(event.task_id)) {
        cancelReasonByTaskId.set(event.task_id, event.reason_text ?? null);
      }
    }
  }

  const items = (data ?? []).map((task) => ({
    ...task,
    cancel_reason_text: cancelReasonByTaskId.get(task.id) ?? null
  }));

  return jsonResponse({ ok: true, items });
});
