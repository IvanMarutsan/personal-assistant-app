import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type TriageBody = {
  inboxItemId?: string;
  action?: "task" | "note" | "discard";
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
};

function mapTriageError(message: string): { status: number; error: string } {
  if (message.includes("inbox_item_not_found")) return { status: 404, error: "inbox_item_not_found" };
  if (message.includes("inbox_item_not_new")) return { status: 409, error: "inbox_item_not_new" };
  if (message.includes("empty_note_body")) return { status: 400, error: "empty_note_body" };
  if (message.includes("invalid_action")) return { status: 400, error: "invalid_action" };
  if (message.includes("project_not_found")) return { status: 400, error: "project_not_found" };
  if (message.includes("invalid_importance")) return { status: 400, error: "invalid_importance" };
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
    p_due_at: body.dueAt ?? null,
    p_scheduled_for: body.scheduledFor ?? null
  });

  if (error) {
    const mapped = mapTriageError(error.message);
    return jsonResponse({ ok: false, error: mapped.error, message: error.message }, mapped.status);
  }

  return jsonResponse({ ok: true, result: data });
});
