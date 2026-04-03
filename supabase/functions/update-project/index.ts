import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type UpdateProjectBody = {
  projectId?: string;
  name?: string;
  status?: "active" | "on_hold" | "archived";
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

  const body = await safeJson<UpdateProjectBody>(req);
  if (!body?.projectId) {
    return jsonResponse({ ok: false, error: "missing_project_id" }, 400);
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (!trimmed) {
      return jsonResponse({ ok: false, error: "invalid_name" }, 400);
    }
    updates.name = trimmed.slice(0, 100);
  }

  if (body.status) {
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse({ ok: false, error: "nothing_to_update" }, 400);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", body.projectId)
    .eq("user_id", sessionUser.userId)
    .select("id, name, status, rank")
    .maybeSingle();

  if (error) {
    return jsonResponse({ ok: false, error: "project_update_failed", message: error.message }, 500);
  }

  if (!data) {
    return jsonResponse({ ok: false, error: "project_not_found" }, 404);
  }

  return jsonResponse({ ok: true, item: data });
});
