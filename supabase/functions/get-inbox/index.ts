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
    .from("inbox_items")
    .select(
      "id, status, source_type, source_channel, raw_text, transcript_text, voice_file_id, captured_at, meta"
    )
    .eq("user_id", sessionUser.userId)
    .eq("status", "new")
    .order("captured_at", { ascending: false });

  if (error) {
    return jsonResponse({ ok: false, error: "inbox_fetch_failed" }, 500);
  }

  return jsonResponse({ ok: true, items: data ?? [] });
});
