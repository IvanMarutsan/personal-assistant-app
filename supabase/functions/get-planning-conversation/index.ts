import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import {
  loadPlanningConversationState,
  normalizeScopeDateForType,
  validateScopeDate,
  validateScopeType
} from "../_shared/planning-conversation.ts";
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

  const url = new URL(req.url);
  const scopeType = validateScopeType(url.searchParams.get("scopeType"));
  const scopeDate = validateScopeDate(url.searchParams.get("scopeDate"));
  if (!scopeType || !scopeDate) {
    return jsonResponse({ ok: false, error: "invalid_scope" }, 400);
  }

  try {
    const supabase = createAdminClient();
    const normalizedScopeDate = await normalizeScopeDateForType(supabase, sessionUser.userId, scopeType, scopeDate);
    const state = await loadPlanningConversationState(
      supabase,
      sessionUser.userId,
      scopeType,
      normalizedScopeDate
    );
    return jsonResponse({ ok: true, ...state });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "planning_conversation_load_failed",
        message: error instanceof Error ? error.message : "unknown_error"
      },
      500
    );
  }
});
