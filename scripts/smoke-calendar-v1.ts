import assert from "node:assert/strict";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const EDGE_BASE_URL = required("EDGE_BASE_URL");
const SUPABASE_ANON_KEY = required("SUPABASE_ANON_KEY");
const SESSION_TOKEN = required("CALENDAR_SMOKE_SESSION_TOKEN");
const CREATE_EVENT = process.env.CALENDAR_SMOKE_CREATE === "1";

function edgeUrl(path: string): string {
  return `${EDGE_BASE_URL.replace(/\/$/, "")}/${path}`;
}

async function edgeCall<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(edgeUrl(path), {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "content-type": "application/json",
      "x-app-session": SESSION_TOKEN,
      ...(init.headers ?? {})
    }
  });

  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;

  if (!response.ok) {
    throw new Error(
      `Edge call failed (${path}): ${body?.message ?? body?.error ?? response.status}`
    );
  }

  return body as T;
}

async function main() {
  const status = await edgeCall<{
    ok: true;
    connected: boolean;
    email: string | null;
    calendarId: string | null;
  }>("get-google-calendar-status", { method: "GET" });

  assert.equal(typeof status.connected, "boolean");
  console.log("Calendar status:", status);

  if (!status.connected) {
    console.log("Calendar smoke: SKIP upcoming/create (not connected).");
    return;
  }

  const upcoming = await edgeCall<{
    ok: true;
    items: Array<{ id: string; title: string }>;
  }>("get-google-calendar-upcoming", { method: "GET" });
  assert.ok(Array.isArray(upcoming.items));
  console.log("Calendar upcoming count:", upcoming.items.length);

  if (!CREATE_EVENT) {
    console.log("Calendar smoke: SKIP create event (set CALENDAR_SMOKE_CREATE=1 to enable).");
    return;
  }

  const now = new Date();
  now.setMinutes(now.getMinutes() + 20);
  now.setSeconds(0, 0);
  const end = new Date(now.getTime() + 30 * 60_000);

  const created = await edgeCall<{
    ok: true;
    event: { id: string; htmlLink: string | null };
  }>("create-google-calendar-event", {
    method: "POST",
    body: JSON.stringify({
      title: `SMOKE Calendar Event ${Date.now()}`,
      description: "Created by smoke-calendar-v1.ts",
      startAt: now.toISOString(),
      endAt: end.toISOString(),
      timezone: "UTC"
    })
  });

  assert.ok(created.event.id);
  console.log("Calendar event created:", created.event);
}

main().catch((error) => {
  console.error("Calendar smoke: FAIL", error);
  process.exit(1);
});
