import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CreateNoteBody = {
  title?: string | null;
  body?: string;
  projectId?: string | null;
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

  const body = await safeJson<CreateNoteBody>(req);
  const nextBody = body?.body?.trim();
  if (!nextBody) {
    return jsonResponse({ ok: false, error: "empty_note_body" }, 400);
  }

  const nextTitle = typeof body?.title === "string" ? body.title.trim() : null;

  const supabase = createAdminClient();

  let projectId: string | null = null;
  if (body?.projectId) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", body.projectId)
      .eq("user_id", sessionUser.userId)
      .maybeSingle();

    if (projectError || !project) {
      return jsonResponse({ ok: false, error: "project_not_found" }, 400);
    }
    projectId = project.id as string;
  }

  const { data, error } = await supabase
    .from("notes")
    .insert({
      user_id: sessionUser.userId,
      project_id: projectId,
      title: nextTitle && nextTitle.length > 0 ? nextTitle : null,
      body: nextBody,
      source_type: "text",
      source_channel: "mini_app"
    })
    .select("id")
    .single();

  if (error || !data) {
    return jsonResponse({ ok: false, error: "note_create_failed", message: error?.message ?? null }, 500);
  }

  return jsonResponse({ ok: true, noteId: data.id });
});
