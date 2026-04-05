import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type DeleteWorklogBody = {
  worklogId?: string;
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

  const body = await safeJson<DeleteWorklogBody>(req);
  if (!body?.worklogId) {
    return jsonResponse({ ok: false, error: "missing_worklog_id" }, 400);
  }

  const supabase = createAdminClient();
  const { data: worklog, error: worklogError } = await supabase
    .from("worklogs")
    .select("id")
    .eq("id", body.worklogId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (worklogError || !worklog) {
    return jsonResponse({ ok: false, error: "worklog_not_found" }, 404);
  }

  const { error } = await supabase
    .from("worklogs")
    .delete()
    .eq("id", body.worklogId)
    .eq("user_id", sessionUser.userId);

  if (error) {
    return jsonResponse({ ok: false, error: "worklog_delete_failed", message: error.message }, 500);
  }

  return jsonResponse({ ok: true, worklogId: body.worklogId });
});
