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
      "id, title, task_type, status, project_id, due_at, scheduled_for, is_protected_essential, projects(name)"
    )
    .eq("user_id", sessionUser.userId)
    .neq("status", "done")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return jsonResponse({ ok: false, error: "tasks_fetch_failed" }, 500);
  }

  return jsonResponse({ ok: true, items: data ?? [] });
});
