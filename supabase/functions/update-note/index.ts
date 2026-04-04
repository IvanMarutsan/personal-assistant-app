import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type UpdateNoteBody = {
  noteId?: string;
  title?: string | null;
  body?: string;
  convertToTask?: boolean;
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

  const body = await safeJson<UpdateNoteBody>(req);
  if (!body?.noteId) {
    return jsonResponse({ ok: false, error: "missing_note_id" }, 400);
  }

  const supabase = createAdminClient();

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("id, user_id, title, body, project_id, source_type, source_channel")
    .eq("id", body.noteId)
    .eq("user_id", sessionUser.userId)
    .maybeSingle();

  if (noteError || !note) {
    return jsonResponse({ ok: false, error: "note_not_found" }, 404);
  }

  const nextTitle = typeof body.title === "string" ? body.title.trim() : (body.title ?? note.title ?? null);
  const nextBody = typeof body.body === "string" ? body.body.trim() : note.body;
  const nextProjectId = body.projectId === undefined ? note.project_id : body.projectId;

  if (!nextBody) {
    return jsonResponse({ ok: false, error: "empty_note_body" }, 400);
  }

  const { error: updateError } = await supabase
    .from("notes")
    .update({
      title: nextTitle && nextTitle.length > 0 ? nextTitle : null,
      body: nextBody,
      project_id: nextProjectId
    })
    .eq("id", note.id)
    .eq("user_id", sessionUser.userId);

  if (updateError) {
    return jsonResponse({ ok: false, error: "note_update_failed", message: updateError.message }, 500);
  }

  let createdTaskId: string | null = null;

  if (body.convertToTask) {
    const taskTitle = (nextTitle && nextTitle.length > 0 ? nextTitle : nextBody.split("\n")[0]?.trim()) || "Нотатка";
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .insert({
        user_id: sessionUser.userId,
        project_id: nextProjectId,
        title: taskTitle.slice(0, 120),
        details: nextBody,
        task_type: "admin_operational",
        status: "planned",
        importance: 3,`r`n        scheduled_for: null,`r`n        due_at: null,`r`n        estimated_minutes: null
      })
      .select("id")
      .single();

    if (taskError || !task) {
      return jsonResponse({ ok: false, error: "note_convert_failed", message: taskError?.message ?? null }, 500);
    }

    createdTaskId = task.id as string;

    const { error: deleteError } = await supabase
      .from("notes")
      .delete()
      .eq("id", note.id)
      .eq("user_id", sessionUser.userId);

    if (deleteError) {
      return jsonResponse({ ok: false, error: "note_cleanup_failed", message: deleteError.message }, 500);
    }
  }

  return jsonResponse({ ok: true, noteId: note.id, createdTaskId });
});

