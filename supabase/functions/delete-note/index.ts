import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type DeleteNoteBody = {
  noteId?: string;
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

  const body = await safeJson<DeleteNoteBody>(req);
  if (!body?.noteId) {
    return jsonResponse({ ok: false, error: "missing_note_id" }, 400);
  }

  const supabase = createAdminClient();
  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("id")
    .eq("id", body.noteId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (noteError || !note) {
    return jsonResponse({ ok: false, error: "note_not_found" }, 404);
  }

  const { error } = await supabase
    .from("notes")
    .delete()
    .eq("id", body.noteId)
    .eq("user_id", sessionUser.userId);

  if (error) {
    return jsonResponse({ ok: false, error: "note_delete_failed", message: error.message }, 500);
  }

  return jsonResponse({ ok: true, noteId: body.noteId });
});
