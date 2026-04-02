import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type TriageBody = {
  inboxItemId?: string;
  action?: "task" | "note" | "discard";
  title?: string;
  details?: string;
  noteBody?: string;
};

function mapTriageError(message: string): { status: number; error: string } {
  if (message.includes("inbox_item_not_found")) return { status: 404, error: "inbox_item_not_found" };
  if (message.includes("inbox_item_not_new")) return { status: 409, error: "inbox_item_not_new" };
  if (message.includes("empty_note_body")) return { status: 400, error: "empty_note_body" };
  if (message.includes("invalid_action")) return { status: 400, error: "invalid_action" };
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
    p_note_body: body.noteBody ?? null
  });

  if (error) {
    const mapped = mapTriageError(error.message);
    return jsonResponse({ ok: false, error: mapped.error, message: error.message }, mapped.status);
  }

  return jsonResponse({ ok: true, result: data });
});
