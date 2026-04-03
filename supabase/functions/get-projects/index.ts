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
    .from("projects")
    .select("id, name, status, rank")
    .eq("user_id", sessionUser.userId)
    .neq("status", "archived")
    .order("rank", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return jsonResponse({ ok: false, error: "projects_fetch_failed" }, 500);
  }

  return jsonResponse({ ok: true, items: data ?? [] });
});
