import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type CreateProjectBody = {
  name?: string;
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

  const body = await safeJson<CreateProjectBody>(req);
  const name = body?.name?.trim();
  if (!name) {
    return jsonResponse({ ok: false, error: "missing_name" }, 400);
  }

  const supabase = createAdminClient();
  const { data: rankRow } = await supabase
    .from("projects")
    .select("rank")
    .eq("user_id", sessionUser.userId)
    .order("rank", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextRank = (typeof rankRow?.rank === "number" ? rankRow.rank : 0) + 1;

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: sessionUser.userId,
      name: name.slice(0, 100),
      status: "active",
      rank: nextRank,
      aliases: []
    })
    .select("id, name, status, rank, aliases")
    .single();

  if (error || !data) {
    return jsonResponse({ ok: false, error: "project_create_failed", message: error?.message ?? null }, 500);
  }

  return jsonResponse({ ok: true, item: data });
});
