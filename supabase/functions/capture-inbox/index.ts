import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CaptureInboxBody = {
  text?: string;
  sourceType?: "text" | "voice";
  sourceChannel?: "mini_app" | "telegram_bot";
  transcriptText?: string;
  voiceFileId?: string;
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

  const body = await safeJson<CaptureInboxBody>(req);
  const sourceType = body?.sourceType ?? "text";
  const sourceChannel = body?.sourceChannel ?? "mini_app";

  if (sourceType === "text" && !body?.text?.trim()) {
    return jsonResponse({ ok: false, error: "missing_text" }, 400);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("inbox_items")
    .insert({
      user_id: sessionUser.userId,
      status: "new",
      source_type: sourceType,
      source_channel: sourceChannel,
      raw_text: body?.text?.trim() || null,
      transcript_text: body?.transcriptText ?? null,
      voice_file_id: body?.voiceFileId ?? null,
      meta: {}
    })
    .select("id, status, raw_text, source_type, source_channel, captured_at")
    .single();

  if (error || !data) {
    return jsonResponse({ ok: false, error: "capture_failed" }, 500);
  }

  return jsonResponse({ ok: true, item: data });
});
