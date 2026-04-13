import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";
import { deleteCalendarBlock } from "../_shared/calendar-blocks.ts";

type Body = { id?: string };

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

  const body = await safeJson<Body>(req);
  if (!body?.id) return jsonResponse({ ok: false, error: "missing_id" }, 400);

  try {
    await deleteCalendarBlock({ userId: sessionUser.userId, blockId: body.id });
    return jsonResponse({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "calendar_block_not_found") {
      return jsonResponse({ ok: false, error: "calendar_block_not_found" }, 404);
    }
    console.error("[delete-calendar-block] failed", error);
    return jsonResponse({ ok: false, error: "calendar_block_delete_failed" }, 500);
  }
});
