import {
  buildMiniAppReturnUrl,
  consumeOAuthState,
  exchangeGoogleCodeForToken,
  fetchGoogleEmail,
  upsertGoogleConnection
} from "../_shared/google-calendar.ts";

function redirect(url: string): Response {
  return Response.redirect(url, 302);
}

function errorRedirect(reason: string): Response {
  const url = buildMiniAppReturnUrl({ returnPath: "/calendar", status: "error", reason });
  return redirect(url);
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("method_not_allowed", { status: 405 });

  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return errorRedirect(`oauth_${oauthError}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorRedirect("missing_code_or_state");

  const statePayload = await consumeOAuthState(state);
  if (!statePayload) return errorRedirect("invalid_or_expired_state");

  try {
    const token = await exchangeGoogleCodeForToken(code);
    const googleEmail = await fetchGoogleEmail(token.access_token);
    await upsertGoogleConnection({
      userId: statePayload.userId,
      token,
      googleEmail
    });

    const returnUrl = buildMiniAppReturnUrl({
      returnPath: statePayload.returnPath,
      status: "success"
    });
    return redirect(returnUrl);
  } catch (error) {
    console.error("[google-calendar-oauth-callback] failed", error);
    const failUrl = buildMiniAppReturnUrl({
      returnPath: statePayload.returnPath,
      status: "error",
      reason: "google_oauth_callback_failed"
    });
    return redirect(failUrl);
  }
});
