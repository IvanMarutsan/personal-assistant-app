import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CreateWorklogBody = {
  body?: string;
  projectId?: string | null;
  occurredAt?: string | null;
  source?: string | null;
};

function isIsoDateTime(value: string | null | undefined): value is string {
  if (!value) return false;
  return !Number.isNaN(Date.parse(value));
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

  const body = await safeJson<CreateWorklogBody>(req);
  const text = body?.body?.trim();
  if (!text) {
    return jsonResponse({ ok: false, error: "missing_body" }, 400);
  }

  if (body?.occurredAt !== undefined && body.occurredAt !== null && !isIsoDateTime(body.occurredAt)) {
    return jsonResponse({ ok: false, error: "invalid_occurred_at" }, 400);
  }

  const supabase = createAdminClient();

  if (body?.projectId) {
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", body.projectId)
      .eq("user_id", sessionUser.userId)
      .maybeSingle();

    if (!project) {
      return jsonResponse({ ok: false, error: "project_not_found" }, 400);
    }
  }

  const { data, error } = await supabase
    .from("worklogs")
    .insert({
      user_id: sessionUser.userId,
      body: text,
      project_id: body?.projectId ?? null,
      occurred_at: body?.occurredAt ?? new Date().toISOString(),
      source: body?.source?.trim() ? body.source.trim().slice(0, 40) : "manual"
    })
    .select("id, body, occurred_at, created_at, updated_at, project_id, source, projects(name)")
    .single();

  if (error || !data) {
    return jsonResponse({ ok: false, error: "worklog_create_failed", message: error?.message ?? null }, 500);
  }

  return jsonResponse({ ok: true, item: data });
});
