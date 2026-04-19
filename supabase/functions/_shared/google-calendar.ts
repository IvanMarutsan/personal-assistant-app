import { createHash } from "node:crypto";
import { createAdminClient, requiredEnv } from "./db.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/tasks.readonly"
].join(" ");
const STATE_TTL_SECONDS = Number(Deno.env.get("GOOGLE_OAUTH_STATE_TTL_SECONDS") ?? "600");
const TOKEN_REFRESH_BUFFER_SECONDS = Number(Deno.env.get("GOOGLE_TOKEN_REFRESH_BUFFER_SECONDS") ?? "90");
const STATE_PEPPER = Deno.env.get("GOOGLE_OAUTH_STATE_PEPPER") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const DEFAULT_CALENDAR_ID = "primary";
const DEFAULT_TASK_LIST_ID = "@default";
const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

export type GoogleCalendarConnection = {
  user_id: string;
  provider: string;
  google_email: string | null;
  access_token: string;
  refresh_token: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: string | null;
  calendar_id: string;
  selected_calendar_ids: string[] | null;
  default_calendar_id: string | null;
  default_task_list_id: string | null;
};

export type GoogleCalendarSelectionState = {
  defaultCalendarId: string;
  selectedCalendarIds: string[];
  defaultTaskListId: string;
};

export type GoogleAccessContext = {
  accessToken: string;
  calendarId: string;
  defaultCalendarId: string;
  selectedCalendarIds: string[];
  defaultTaskListId: string;
  googleEmail: string | null;
  scope: string | null;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  selected: boolean;
  default: boolean;
  accessRole: string | null;
  backgroundColor: string | null;
};

export type GoogleTaskListItem = {
  id: string;
  title: string;
  updated: string | null;
  isDefault: boolean;
};

export type GoogleTasksAccessState =
  | "usable"
  | "scope_missing"
  | "permission_denied"
  | "auth_expired"
  | "not_connected"
  | "unknown";

export type GoogleTasksAccessProbe = {
  state: GoogleTasksAccessState;
  errorCode: string | null;
  taskLists: GoogleTaskListItem[];
};

export type ResolvedGoogleCalendarSelection = {
  selectedCalendarIds: string[];
  defaultCalendarId: string;
};

export type ResolvedGoogleTaskListSelection = {
  defaultTaskListId: string;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
};

type GoogleCalendarListApiItem = {
  id?: string;
  summary?: string | null;
  description?: string | null;
  primary?: boolean;
  accessRole?: string | null;
  backgroundColor?: string | null;
};

type GoogleTaskListApiItem = {
  id?: string;
  title?: string | null;
  updated?: string | null;
};

type GoogleApiErrorEnvelope = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      reason?: string;
      message?: string;
      domain?: string;
    }>;
  };
};

function randomHex(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stateHash(state: string): string {
  return createHash("sha256").update(`${STATE_PEPPER}:${state}`).digest("hex");
}

function computeExpiresAt(expiresInSeconds?: number): string | null {
  if (!expiresInSeconds || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime();
  if (Number.isNaN(ms)) return true;
  return ms <= Date.now() + TOKEN_REFRESH_BUFFER_SECONDS * 1000;
}

function googleClientId(): string {
  return requiredEnv("GOOGLE_CLIENT_ID");
}

function googleClientSecret(): string {
  return requiredEnv("GOOGLE_CLIENT_SECRET");
}

export function googleRedirectUri(): string {
  return requiredEnv("GOOGLE_REDIRECT_URI");
}

export function googleScopes(): string {
  return Deno.env.get("GOOGLE_CALENDAR_SCOPES")?.trim() || DEFAULT_SCOPES;
}

export function miniAppBaseUrl(): string {
  return requiredEnv("MINI_APP_BASE_URL");
}

function normalizeSelectedCalendarIds(value: string[] | null | undefined, fallback: string): string[] {
  const unique = Array.from(new Set((value ?? []).map((item) => item?.trim()).filter(Boolean)));
  if (unique.length > 0) return unique;
  return [fallback];
}

function normalizeDefaultCalendarId(value: string | null | undefined, selectedCalendarIds: string[]): string {
  const trimmed = value?.trim() || null;
  if (trimmed && selectedCalendarIds.includes(trimmed)) return trimmed;
  return selectedCalendarIds[0] ?? DEFAULT_CALENDAR_ID;
}

function normalizeDefaultTaskListId(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_TASK_LIST_ID;
}

export async function parseGoogleApiError(response: Response): Promise<{
  code: number;
  message: string | null;
  status: string | null;
  reason: string | null;
}> {
  const payload = (await response.json().catch(() => null)) as GoogleApiErrorEnvelope | null;
  const errorInfo = payload?.error ?? null;
  const reason = errorInfo?.errors?.find((item) => item?.reason)?.reason ?? null;
  return {
    code: errorInfo?.code ?? response.status,
    message: errorInfo?.message ?? null,
    status: errorInfo?.status ?? null,
    reason
  };
}

export function classifyGoogleTasksApiError(input: {
  action: "list" | "create" | "update" | "fetch" | "delete";
  status: number;
  message: string | null;
  reason: string | null;
}): string {
  if (input.status === 401) return "google_tasks_auth_expired";
  if (input.status === 404 && ["update", "fetch", "delete"].includes(input.action)) return "google_task_not_found";
  if (input.status === 403) {
    const combined = `${input.reason ?? ""} ${input.message ?? ""}`.toLowerCase();
    if (
      combined.includes("accessnotconfigured") ||
      combined.includes("service_disabled") ||
      combined.includes("tasks api has not been used") ||
      combined.includes("api has not been used in project") ||
      combined.includes("is disabled")
    ) {
      return "google_tasks_api_disabled";
    }
    if (combined.includes("insufficientpermissions")) {
      return "google_tasks_insufficient_permissions";
    }
    return "google_tasks_permission_denied";
  }
  return `google_task_${input.action}_failed_${input.status}`;
}

function resolveTaskListSelectionAgainstAvailableLists(input: {
  defaultTaskListId: string | null | undefined;
  taskLists: Array<Pick<GoogleTaskListItem, "id">>;
}): ResolvedGoogleTaskListSelection {
  const requestedId = normalizeDefaultTaskListId(input.defaultTaskListId);
  const availableIds = new Set(input.taskLists.map((item) => item.id));
  if (requestedId !== DEFAULT_TASK_LIST_ID && availableIds.has(requestedId)) {
    return { defaultTaskListId: requestedId };
  }
  return { defaultTaskListId: input.taskLists[0]?.id ?? DEFAULT_TASK_LIST_ID };
}

export function hasGoogleTasksScope(scope: string | null | undefined): boolean {
  return Boolean(scope?.split(/\s+/).includes(GOOGLE_TASKS_SCOPE));
}

export function calendarSelectionState(connection: GoogleCalendarConnection | null): GoogleCalendarSelectionState {
  const baseCalendarId = connection?.calendar_id?.trim() || DEFAULT_CALENDAR_ID;
  const selectedCalendarIds = normalizeSelectedCalendarIds(connection?.selected_calendar_ids, baseCalendarId);
  return {
    defaultCalendarId: normalizeDefaultCalendarId(connection?.default_calendar_id ?? connection?.calendar_id, selectedCalendarIds),
    selectedCalendarIds,
    defaultTaskListId: normalizeDefaultTaskListId(connection?.default_task_list_id)
  };
}

function canonicalCalendarId(value: string | null | undefined, primaryCalendarId: string | null): string | null {
  const trimmed = value?.trim() || null;
  if (!trimmed) return null;
  if (trimmed === DEFAULT_CALENDAR_ID && primaryCalendarId) return primaryCalendarId;
  return trimmed;
}

export function resolveCalendarSelectionAgainstAvailableCalendars(input: {
  selectedCalendarIds: string[];
  defaultCalendarId: string | null;
  calendars: Array<Pick<GoogleCalendarListItem, "id" | "primary">>;
}): ResolvedGoogleCalendarSelection {
  const primaryCalendarId = input.calendars.find((calendar) => calendar.primary)?.id ?? null;
  const availableIds = new Set(input.calendars.map((calendar) => calendar.id));

  const selectedCalendarIds = Array.from(
    new Set(
      input.selectedCalendarIds
        .map((id) => canonicalCalendarId(id, primaryCalendarId))
        .filter((id): id is string => Boolean(id && availableIds.has(id)))
    )
  );

  const fallbackDefault =
    primaryCalendarId ??
    input.calendars[0]?.id ??
    DEFAULT_CALENDAR_ID;

  const normalizedSelected = selectedCalendarIds.length > 0 ? selectedCalendarIds : [fallbackDefault];
  const canonicalDefault = canonicalCalendarId(input.defaultCalendarId, primaryCalendarId);
  const defaultCalendarId =
    canonicalDefault && normalizedSelected.includes(canonicalDefault)
      ? canonicalDefault
      : normalizedSelected[0];

  return {
    selectedCalendarIds: normalizedSelected,
    defaultCalendarId
  };
}

export async function createOAuthState(input: { userId: string; returnPath: string }): Promise<string> {
  const supabase = createAdminClient();
  const rawState = randomHex(32);
  const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();

  const { error } = await supabase.from("calendar_oauth_states").insert({
    user_id: input.userId,
    state_hash: stateHash(rawState),
    return_path: input.returnPath,
    expires_at: expiresAt
  });

  if (error) throw new Error("oauth_state_create_failed");
  return rawState;
}

export async function consumeOAuthState(rawState: string): Promise<{ userId: string; returnPath: string } | null> {
  const supabase = createAdminClient();
  const hash = stateHash(rawState);

  const { data, error } = await supabase
    .from("calendar_oauth_states")
    .select("id, user_id, return_path, expires_at")
    .eq("state_hash", hash)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase.from("calendar_oauth_states").delete().eq("id", data.id);
    return null;
  }

  await supabase.from("calendar_oauth_states").delete().eq("id", data.id);
  return { userId: data.user_id as string, returnPath: (data.return_path as string) || "/calendar" };
}

export function buildGoogleAuthUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", googleScopes());
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeToken(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = (await response.json().catch(() => null)) as TokenResponse | null;
  if (!response.ok || !data?.access_token) {
    throw new Error("google_token_exchange_failed");
  }
  return data;
}

export async function exchangeGoogleCodeForToken(code: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("code", code);
  params.set("client_id", googleClientId());
  params.set("client_secret", googleClientSecret());
  params.set("redirect_uri", googleRedirectUri());
  params.set("grant_type", "authorization_code");
  return exchangeToken(params);
}

async function refreshGoogleToken(refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set("refresh_token", refreshToken);
  params.set("client_id", googleClientId());
  params.set("client_secret", googleClientSecret());
  params.set("grant_type", "refresh_token");
  return exchangeToken(params);
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { email?: string } | null;
    return data?.email ?? null;
  } catch {
    return null;
  }
}

export async function upsertGoogleConnection(input: {
  userId: string;
  token: TokenResponse;
  googleEmail?: string | null;
}): Promise<void> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("calendar_connections")
    .select("refresh_token, selected_calendar_ids, default_calendar_id, default_task_list_id, calendar_id")
    .eq("user_id", input.userId)
    .eq("provider", "google")
    .maybeSingle();

  const refreshToken = input.token.refresh_token ?? (existing?.refresh_token as string | null) ?? null;
  const baseCalendarId = (existing?.calendar_id as string | null) ?? DEFAULT_CALENDAR_ID;
  const selectedCalendarIds = normalizeSelectedCalendarIds(existing?.selected_calendar_ids as string[] | null | undefined, baseCalendarId);
  const defaultCalendarId = normalizeDefaultCalendarId(
    (existing?.default_calendar_id as string | null | undefined) ?? baseCalendarId,
    selectedCalendarIds
  );
  const defaultTaskListId = normalizeDefaultTaskListId(existing?.default_task_list_id as string | null | undefined);

  const { error } = await supabase.from("calendar_connections").upsert(
    {
      user_id: input.userId,
      provider: "google",
      google_email: input.googleEmail ?? null,
      access_token: input.token.access_token,
      refresh_token: refreshToken,
      token_type: input.token.token_type ?? null,
      scope: input.token.scope ?? null,
      expires_at: computeExpiresAt(input.token.expires_in),
      calendar_id: defaultCalendarId,
      selected_calendar_ids: selectedCalendarIds,
      default_calendar_id: defaultCalendarId,
      default_task_list_id: defaultTaskListId
    },
    { onConflict: "user_id,provider" }
  );

  if (error) throw new Error("google_connection_upsert_failed");
}

export async function getGoogleConnection(userId: string): Promise<GoogleCalendarConnection | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("calendar_connections")
    .select("user_id, provider, google_email, access_token, refresh_token, token_type, scope, expires_at, calendar_id, selected_calendar_ids, default_calendar_id, default_task_list_id")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  if (error) throw new Error("calendar_connection_fetch_failed");
  return (data as GoogleCalendarConnection | null) ?? null;
}

async function resolveGoogleAccessTokenForUser(userId: string, forceRefresh: boolean): Promise<GoogleAccessContext> {
  const connection = await getGoogleConnection(userId);
  if (!connection) throw new Error("calendar_not_connected");

  const selection = calendarSelectionState(connection);

  if (!forceRefresh && !isExpiringSoon(connection.expires_at)) {
    return {
      accessToken: connection.access_token,
      calendarId: selection.defaultCalendarId,
      defaultCalendarId: selection.defaultCalendarId,
      selectedCalendarIds: selection.selectedCalendarIds,
      defaultTaskListId: selection.defaultTaskListId,
      googleEmail: connection.google_email,
      scope: connection.scope ?? null
    };
  }

  if (!connection.refresh_token) throw new Error("calendar_refresh_token_missing");

  const refreshed = await refreshGoogleToken(connection.refresh_token);
  const supabase = createAdminClient();

  const { error } = await supabase
    .from("calendar_connections")
    .update({
      access_token: refreshed.access_token,
      token_type: refreshed.token_type ?? connection.token_type,
      scope: refreshed.scope ?? connection.scope,
      expires_at: computeExpiresAt(refreshed.expires_in)
    })
    .eq("user_id", userId)
    .eq("provider", "google");

  if (error) throw new Error("calendar_refresh_update_failed");

  return {
    accessToken: refreshed.access_token,
    calendarId: selection.defaultCalendarId,
    defaultCalendarId: selection.defaultCalendarId,
    selectedCalendarIds: selection.selectedCalendarIds,
    defaultTaskListId: selection.defaultTaskListId,
    googleEmail: connection.google_email,
    scope: refreshed.scope ?? connection.scope ?? null
  };
}

export async function getGoogleAccessTokenForUser(userId: string): Promise<GoogleAccessContext> {
  return await resolveGoogleAccessTokenForUser(userId, false);
}

export async function forceRefreshGoogleAccessTokenForUser(userId: string): Promise<GoogleAccessContext> {
  return await resolveGoogleAccessTokenForUser(userId, true);
}

export async function listGoogleCalendars(userId: string): Promise<GoogleCalendarListItem[]> {
  const auth = await getGoogleAccessTokenForUser(userId);
  const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  const payload = (await response.json().catch(() => null)) as { items?: GoogleCalendarListApiItem[] } | null;
  if (!response.ok) {
    throw new Error(response.status === 403 ? "calendar_permission_denied" : `calendar_list_fetch_failed_${response.status}`);
  }

  const allowed = new Set(["owner", "writer", "reader", "freeBusyReader"]);
  const rawItems = (payload?.items ?? [])
    .filter((item) => item.id && allowed.has(item.accessRole ?? "reader"))
    .map((item) => ({
      id: item.id!,
      summary: item.summary?.trim() || item.id!,
      description: item.description?.trim() || null,
      primary: Boolean(item.primary),
      selected: false,
      default: false,
      accessRole: item.accessRole ?? null,
      backgroundColor: item.backgroundColor ?? null
    }));

  const resolved = resolveCalendarSelectionAgainstAvailableCalendars({
    selectedCalendarIds: auth.selectedCalendarIds,
    defaultCalendarId: auth.defaultCalendarId,
    calendars: rawItems
  });

  return rawItems
    .map((item) => ({
      ...item,
      selected: resolved.selectedCalendarIds.includes(item.id),
      default: resolved.defaultCalendarId === item.id
    }))
    .sort((a, b) => {
      if (a.default && !b.default) return -1;
      if (b.default && !a.default) return 1;
      if (a.primary && !b.primary) return -1;
      if (b.primary && !a.primary) return 1;
      return a.summary.localeCompare(b.summary, "uk-UA");
    });
}

async function listGoogleTaskListsAttempt(userId: string, forceRefresh: boolean): Promise<GoogleTaskListItem[]> {
  const auth = forceRefresh
    ? await forceRefreshGoogleAccessTokenForUser(userId)
    : await getGoogleAccessTokenForUser(userId);
  if (!hasGoogleTasksScope(auth.scope)) {
    throw new Error("google_tasks_scope_missing");
  }

  const response = await fetch("https://tasks.googleapis.com/tasks/v1/users/@me/lists", {
    headers: { authorization: `Bearer ${auth.accessToken}` }
  });

  const payload = (await response.json().catch(() => null)) as { items?: GoogleTaskListApiItem[] } | null;
  if (!response.ok) {
    const parsedError = await parseGoogleApiError(
      new Response(JSON.stringify(payload), { status: response.status, headers: response.headers })
    );
    const errorCode = classifyGoogleTasksApiError({
      action: "list",
      status: response.status,
      message: parsedError.message,
      reason: parsedError.reason
    });
    if (!forceRefresh && ["google_tasks_insufficient_permissions", "google_tasks_permission_denied"].includes(errorCode)) {
      return await listGoogleTaskListsAttempt(userId, true);
    }
    throw new Error(errorCode);
  }

  const rawItems = (payload?.items ?? [])
    .filter((item) => item.id)
    .map((item) => ({
      id: item.id!,
      title: item.title?.trim() || item.id!,
      updated: item.updated ?? null,
      isDefault: false
    }));

  const resolved = resolveTaskListSelectionAgainstAvailableLists({
    defaultTaskListId: auth.defaultTaskListId,
    taskLists: rawItems
  });

  return rawItems
    .map((item) => ({
      ...item,
      isDefault: resolved.defaultTaskListId === item.id
    }))
    .sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (b.isDefault && !a.isDefault) return 1;
      return a.title.localeCompare(b.title, "uk-UA");
    });
}

export async function listGoogleTaskLists(userId: string): Promise<GoogleTaskListItem[]> {
  return await listGoogleTaskListsAttempt(userId, false);
}

export async function probeGoogleTasksAccess(userId: string): Promise<GoogleTasksAccessProbe> {
  const connection = await getGoogleConnection(userId);
  if (!connection) {
    return { state: "not_connected", errorCode: "calendar_not_connected", taskLists: [] };
  }

  if (!hasGoogleTasksScope(connection.scope)) {
    return { state: "scope_missing", errorCode: "google_tasks_scope_missing", taskLists: [] };
  }

  try {
    const taskLists = await listGoogleTaskLists(userId);
    return {
      state: "usable",
      errorCode: null,
      taskLists
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "google_tasks_access_failed";
    if (
      [
        "google_tasks_permission_denied",
        "google_tasks_api_disabled",
        "google_tasks_insufficient_permissions",
        "google_task_lists_fetch_failed_403"
      ].includes(message)
    ) {
      return { state: "permission_denied", errorCode: message, taskLists: [] };
    }
    if (
      [
        "calendar_refresh_token_missing",
        "google_tasks_auth_expired",
        "google_task_lists_fetch_failed_401"
      ].includes(message)
    ) {
      return { state: "auth_expired", errorCode: message, taskLists: [] };
    }
    if (message === "google_tasks_scope_missing") {
      return { state: "scope_missing", errorCode: message, taskLists: [] };
    }
    return { state: "unknown", errorCode: message, taskLists: [] };
  }
}

export async function updateGoogleConnectionPreferences(input: {
  userId: string;
  selectedCalendarIds?: string[];
  defaultCalendarId?: string | null;
  defaultTaskListId?: string | null;
}): Promise<GoogleCalendarSelectionState> {
  const connection = await getGoogleConnection(input.userId);
  if (!connection) throw new Error("calendar_not_connected");

  const current = calendarSelectionState(connection);
  const calendars = await listGoogleCalendars(input.userId);
  const resolved = resolveCalendarSelectionAgainstAvailableCalendars({
    selectedCalendarIds: normalizeSelectedCalendarIds(
      input.selectedCalendarIds ?? current.selectedCalendarIds,
      current.defaultCalendarId
    ),
    defaultCalendarId: input.defaultCalendarId ?? current.defaultCalendarId,
    calendars
  });
  const defaultTaskListId = normalizeDefaultTaskListId(input.defaultTaskListId ?? current.defaultTaskListId);

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("calendar_connections")
    .update({
      calendar_id: resolved.defaultCalendarId,
      selected_calendar_ids: resolved.selectedCalendarIds,
      default_calendar_id: resolved.defaultCalendarId,
      default_task_list_id: defaultTaskListId
    })
    .eq("user_id", input.userId)
    .eq("provider", "google");

  if (error) throw new Error("calendar_preferences_update_failed");

  return {
    selectedCalendarIds: resolved.selectedCalendarIds,
    defaultCalendarId: resolved.defaultCalendarId,
    defaultTaskListId
  };
}

export function buildMiniAppReturnUrl(input: {
  returnPath: string;
  status: "success" | "error";
  reason?: string;
}): string {
  const base = miniAppBaseUrl();
  const normalized = input.returnPath.startsWith("/") ? input.returnPath : `/${input.returnPath}`;
  const url = new URL(normalized, base);
  url.searchParams.set("calendar_connect", input.status);
  if (input.reason) url.searchParams.set("reason", input.reason);
  return url.toString();
}
