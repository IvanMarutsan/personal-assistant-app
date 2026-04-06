import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { syncTaskCalendarAfterMutation } from "../_shared/task-calendar-sync.ts";

type TaskStatus = "planned" | "in_progress" | "blocked" | "done" | "cancelled";

type UpdateTaskStatusBody = {
  taskId?: string;
  status?: TaskStatus;
  reasonCode?:
    | "reprioritized"
    | "blocked_dependency"
    | "urgent_interrupt"
    | "calendar_conflict"
    | "underestimated"
    | "low_energy"
    | "waiting_response"
    | "waiting_on_external"
    | "personal_issue"
    | "other";
  reasonText?: string;
  rescheduleTo?: string;
  dueAt?: string;
  postponeMinutes?: number;
};

function mapTaskError(message: string): { status: number; error: string } {
  if (message.includes("task_not_found")) return { status: 404, error: "task_not_found" };
  return { status: 500, error: "task_update_failed" };
}

function toIsoOrNull(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resolveEventHint(body: UpdateTaskStatusBody): "postponed" | "rescheduled" | null {
  if ((body.postponeMinutes ?? 0) > 0) return "postponed";
  if (body.rescheduleTo || body.dueAt) return "rescheduled";
  return null;
}

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

  const body = await safeJson<UpdateTaskStatusBody>(req);
  if (!body?.taskId || !body.status) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const eventHint = resolveEventHint(body);
  const newScheduledFor = toIsoOrNull(body.rescheduleTo);
  const newDueAt = toIsoOrNull(body.dueAt);

  if ((body.rescheduleTo && !newScheduledFor) || (body.dueAt && !newDueAt)) {
    return jsonResponse({ ok: false, error: "invalid_datetime" }, 400);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("update_task_status_atomic", {
    p_user_id: sessionUser.userId,
    p_task_id: body.taskId,
    p_new_status: body.status,
    p_reason_code: body.reasonCode ?? null,
    p_reason_text: body.reasonText ?? null,
    p_new_due_at: newDueAt,
    p_new_scheduled_for: newScheduledFor,
    p_event_hint: eventHint,
    p_postpone_minutes: body.postponeMinutes ?? null
  });

  if (error) {
    const mapped = mapTaskError(error.message);
    return jsonResponse({ ok: false, error: mapped.error, message: error.message }, mapped.status);
  }

  await syncTaskCalendarAfterMutation(supabase, sessionUser.userId, body.taskId);

  return jsonResponse({ ok: true, result: data });
});

