import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type TriageBody = {
  inboxItemId?: string;
  action?: "task" | "note" | "worklog" | "discard";
  title?: string;
  details?: string;
  noteBody?: string;
  projectId?: string;
  taskType?:
    | "deep_work"
    | "quick_communication"
    | "admin_operational"
    | "recurring_essential"
    | "personal_essential"
    | "someday";
  importance?: number;
  dueAt?: string;
  scheduledFor?: string;
  estimatedMinutes?: number | null;
};

function asIsoDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function mapTriageError(message: string): { status: number; error: string } {
  if (message.includes("inbox_item_not_found")) return { status: 404, error: "inbox_item_not_found" };
  if (message.includes("inbox_item_not_new")) return { status: 409, error: "inbox_item_not_new" };
  if (message.includes("empty_note_body")) return { status: 400, error: "empty_note_body" };
  if (message.includes("empty_worklog_body")) return { status: 400, error: "empty_worklog_body" };
  if (message.includes("invalid_action")) return { status: 400, error: "invalid_action" };
  if (message.includes("project_not_found")) return { status: 400, error: "project_not_found" };
  if (message.includes("invalid_importance")) return { status: 400, error: "invalid_importance" };
  if (message.includes("invalid_estimated_minutes")) return { status: 400, error: "invalid_estimated_minutes" };
  return { status: 500, error: "triage_failed" };
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

  const body = await safeJson<TriageBody>(req);
  if (!body?.inboxItemId || !body?.action) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const dueAt = body.dueAt ? asIsoDateTime(body.dueAt) : null;
  const scheduledFor = body.scheduledFor ? asIsoDateTime(body.scheduledFor) : null;
  if (body.dueAt && !dueAt) {
    return jsonResponse({ ok: false, error: "invalid_due_at", details: "dueAt must be ISO datetime" }, 400);
  }
  if (body.scheduledFor && !scheduledFor) {
    return jsonResponse(
      { ok: false, error: "invalid_scheduled_for", details: "scheduledFor must be ISO datetime" },
      400
    );
  }
  if (typeof body.importance === "number" && (body.importance < 1 || body.importance > 5)) {
    return jsonResponse({ ok: false, error: "invalid_importance", details: "importance must be 1..5" }, 400);
  }
  if (
    body.estimatedMinutes !== undefined &&
    body.estimatedMinutes !== null &&
    (!Number.isInteger(body.estimatedMinutes) || body.estimatedMinutes <= 0)
  ) {
    return jsonResponse({ ok: false, error: "invalid_estimated_minutes", details: "estimatedMinutes must be positive" }, 400);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("triage_inbox_item_atomic", {
    p_user_id: sessionUser.userId,
    p_inbox_item_id: body.inboxItemId,
    p_action: body.action,
    p_title: body.title ?? null,
    p_details: body.details ?? null,
    p_note_body: body.noteBody ?? null,
    p_project_id: body.projectId ?? null,
    p_task_type: body.taskType ?? null,
    p_importance: body.importance ?? null,
    p_due_at: dueAt,
    p_scheduled_for: scheduledFor,
    p_estimated_minutes: body.estimatedMinutes ?? null
  });

  if (error) {
    console.error("[triage-inbox-item] rpc_failed", {
      inboxItemId: body.inboxItemId,
      action: body.action,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    const mapped = mapTriageError(error.message);
    return jsonResponse(
      { ok: false, error: mapped.error, message: error.message, details: error.details ?? null },
      mapped.status
    );
  }

  return jsonResponse({ ok: true, result: data });
});

