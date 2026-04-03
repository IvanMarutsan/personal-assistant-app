import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const EDGE_BASE_URL = required("EDGE_BASE_URL");
const SUPABASE_ANON_KEY = required("SUPABASE_ANON_KEY");
const APP_SESSION_PEPPER = process.env.APP_SESSION_PEPPER ?? SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function hashToken(token: string): string {
  return createHash("sha256").update(`${APP_SESSION_PEPPER}:${token}`).digest("hex");
}

function edgeUrl(path: string): string {
  return `${EDGE_BASE_URL.replace(/\/$/, "")}/${path}`;
}

async function edgeCall<T>(sessionToken: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(edgeUrl(path), {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "content-type": "application/json",
      "x-app-session": sessionToken,
      ...(init.headers ?? {})
    }
  });

  const body = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(`Edge call failed (${path}): ${body.message ?? body.error ?? response.status}`);
  }

  return body;
}

async function main() {
  const runId = Date.now();
  const telegramUserId = Number(`91${String(runId).slice(-8)}`);

  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .insert({ telegram_user_id: telegramUserId })
    .select("id")
    .single();
  assert.ifError(userError);
  assert.ok(user?.id);

  const userId = user.id;

  const { error: profileError } = await supabaseAdmin.from("profiles").upsert(
    {
      user_id: userId,
      timezone: "Europe/Copenhagen",
      display_name: `smoke-${runId}`
    },
    { onConflict: "user_id" }
  );
  assert.ifError(profileError);

  const { data: project, error: projectError } = await supabaseAdmin
    .from("projects")
    .insert({
      user_id: userId,
      name: `SMOKE project ${runId}`,
      status: "active"
    })
    .select("id, name")
    .single();
  assert.ifError(projectError);
  assert.ok(project?.id);

  const sessionToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(sessionToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { error: sessionError } = await supabaseAdmin.from("app_sessions").insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt
  });
  assert.ifError(sessionError);

  const captureA = await edgeCall<{ ok: true; item: { id: string } }>(sessionToken, "capture-inbox", {
    method: "POST",
    body: JSON.stringify({ text: `SMOKE inbox ${runId} A`, sourceType: "text", sourceChannel: "mini_app" })
  });
  assert.ok(captureA.item.id);

  const captureB = await edgeCall<{ ok: true; item: { id: string } }>(sessionToken, "capture-inbox", {
    method: "POST",
    body: JSON.stringify({ text: `SMOKE inbox ${runId} B`, sourceType: "text", sourceChannel: "mini_app" })
  });

  const captureC = await edgeCall<{ ok: true; item: { id: string } }>(sessionToken, "capture-inbox", {
    method: "POST",
    body: JSON.stringify({ text: `SMOKE inbox ${runId} C`, sourceType: "text", sourceChannel: "mini_app" })
  });

  const inboxBefore = await edgeCall<{ ok: true; items: Array<{ id: string }> }>(sessionToken, "get-inbox", {
    method: "GET"
  });
  assert.ok(inboxBefore.items.length >= 3);

  const projects = await edgeCall<{ ok: true; items: Array<{ id: string; name: string }> }>(
    sessionToken,
    "get-projects",
    { method: "GET" }
  );
  assert.ok(projects.items.some((item) => item.id === project.id));

  const triageTask = await edgeCall<{ ok: true; result: { task_id: string } }>(
    sessionToken,
    "triage-inbox-item",
    {
      method: "POST",
      body: JSON.stringify({
        inboxItemId: captureA.item.id,
        action: "task",
        title: `SMOKE task ${runId}`,
        details: "structured details",
        projectId: project.id,
        taskType: "quick_communication",
        importance: 5,
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        dueAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
      })
    }
  );
  assert.ok(triageTask.result.task_id);

  const triageNote = await edgeCall<{ ok: true; result: { note_id: string } }>(
    sessionToken,
    "triage-inbox-item",
    {
      method: "POST",
      body: JSON.stringify({
        inboxItemId: captureB.item.id,
        action: "note",
        noteBody: `SMOKE note ${runId}`
      })
    }
  );
  assert.ok(triageNote.result.note_id);

  await edgeCall<{ ok: true }>(sessionToken, "triage-inbox-item", {
    method: "POST",
    body: JSON.stringify({
      inboxItemId: captureC.item.id,
      action: "discard"
    })
  });

  const tasks = await edgeCall<{
    ok: true;
    items: Array<{ id: string; title: string; task_type: string; project_id: string | null }>;
  }>(sessionToken, "get-tasks", {
    method: "GET"
  });
  const smokeTask = tasks.items.find((item) => item.id === triageTask.result.task_id);
  assert.ok(smokeTask, "Expected triaged task in get-tasks");
  assert.equal(smokeTask.task_type, "quick_communication");
  assert.equal(smokeTask.project_id, project.id);

  await edgeCall<{ ok: true }>(sessionToken, "update-task-status", {
    method: "POST",
    body: JSON.stringify({
      taskId: triageTask.result.task_id,
      status: "planned",
      postponeMinutes: 60,
      reasonCode: "reprioritized"
    })
  });

  const planning = await edgeCall<{ ok: true; whatNow: unknown; overload: unknown; dailyReview: unknown }>(
    sessionToken,
    "get-planning-assistant",
    {
      method: "GET"
    }
  );
  assert.ok(planning.whatNow);
  assert.ok(planning.overload);
  assert.ok(planning.dailyReview);

  console.log("Smoke V1: PASS", { runId, userId, taskId: triageTask.result.task_id });
}

main().catch((error) => {
  console.error("Smoke V1: FAIL", error);
  process.exitCode = 1;
});
