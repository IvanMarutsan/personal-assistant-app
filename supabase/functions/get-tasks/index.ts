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
      "id, title, details, task_type, status, last_moved_reason, project_id, due_at, scheduled_for, estimated_minutes, planning_flexibility, is_protected_essential, calendar_provider, calendar_event_id, calendar_sync_mode, calendar_sync_error, projects(name)"
    )
    .eq("user_id", sessionUser.userId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return jsonResponse({ ok: false, error: "tasks_fetch_failed" }, 500);
  }

  const taskIds = (data ?? []).map((item) => item.id);
  const cancelReasonByTaskId = new Map<string, string | null>();
  const calendarLinkByTaskId = new Map<
    string,
    {
      provider: "google";
      provider_event_id: string;
      provider_event_url: string | null;
      title: string;
      starts_at: string;
      ends_at: string;
      timezone: string;
    }
  >();

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

  if (taskIds.length > 0) {
    const { data: calendarLinks } = await supabase
      .from("calendar_event_links")
      .select("task_id, provider, provider_event_id, provider_event_url, title, starts_at, ends_at, timezone, created_at")
      .eq("user_id", sessionUser.userId)
      .eq("provider", "google")
      .in("task_id", taskIds)
      .order("created_at", { ascending: false });

    for (const link of calendarLinks ?? []) {
      if (!link.task_id || calendarLinkByTaskId.has(link.task_id)) continue;
      calendarLinkByTaskId.set(link.task_id, {
        provider: "google",
        provider_event_id: link.provider_event_id,
        provider_event_url: link.provider_event_url ?? null,
        title: link.title,
        starts_at: link.starts_at,
        ends_at: link.ends_at,
        timezone: link.timezone
      });
    }
  }

  const items = (data ?? []).map((task) => ({
    ...task,
    cancel_reason_text: cancelReasonByTaskId.get(task.id) ?? null,
    linked_calendar_event: calendarLinkByTaskId.get(task.id) ?? null
  }));

  return jsonResponse({ ok: true, items });
});




