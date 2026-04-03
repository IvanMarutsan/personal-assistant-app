import { buildGoogleAuthUrl, createOAuthState } from "../_shared/google-calendar.ts";
import { handleOptions, jsonResponse, safeJson } from "../_shared/http.ts";
import { resolveSessionUser } from "../_shared/session.ts";

type StartConnectBody = {
  returnPath?: string;
};

function safeReturnPath(path: string | undefined): string {
  if (!path?.trim()) return "/calendar";
  const value = path.trim();
  if (!value.startsWith("/")) return "/calendar";
  if (value.startsWith("//")) return "/calendar";
  return value;
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

  const body = await safeJson<StartConnectBody>(req);
  const returnPath = safeReturnPath(body?.returnPath);

  try {
    const state = await createOAuthState({ userId: sessionUser.userId, returnPath });
    const authUrl = buildGoogleAuthUrl(state);
    return jsonResponse({ ok: true, authUrl });
  } catch (error) {
    console.error("[start-google-calendar-connect] failed", error);
    return jsonResponse({ ok: false, error: "google_connect_start_failed" }, 500);
  }
});
