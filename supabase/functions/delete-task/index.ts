import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type DeleteTaskBody = {
  taskId?: string;
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

  const body = await safeJson<DeleteTaskBody>(req);
  if (!body?.taskId) {
    return jsonResponse({ ok: false, error: "missing_task_id" }, 400);
  }

  const supabase = createAdminClient();
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (taskError || !task) {
    return jsonResponse({ ok: false, error: "task_not_found" }, 404);
  }

  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", body.taskId)
    .eq("user_id", sessionUser.userId);

  if (error) {
    return jsonResponse({ ok: false, error: "task_delete_failed", message: error.message }, 500);
  }

  return jsonResponse({ ok: true, taskId: body.taskId });
});
