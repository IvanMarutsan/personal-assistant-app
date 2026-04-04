import { createAdminClient } from "../_shared/db.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type UpdateProjectBody = {
  projectId?: string;
  name?: string;
  status?: "active" | "on_hold" | "archived";
  aliases?: string[];
};

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAliases(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of input) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 100);
    if (!trimmed) continue;
    const normalized = normalizeComparableText(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
    if (result.length >= 12) break;
  }

  return result;
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

  if (body.aliases !== undefined) {
    updates.aliases = normalizeAliases(body.aliases);
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
    .select("id, name, status, rank, aliases")
    .maybeSingle();

  if (error) {
    return jsonResponse({ ok: false, error: "project_update_failed", message: error.message }, 500);
  }

  if (!data) {
    return jsonResponse({ ok: false, error: "project_not_found" }, 404);
  }

  return jsonResponse({ ok: true, item: data });
});
