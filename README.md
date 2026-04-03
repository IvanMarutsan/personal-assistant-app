# personal-assistant-app

React Mini App scaffold for Personal Assistant.

See stabilization runbook: `docs/voice-miniapp-stabilization-runbook.md`.
See hosting runbook: `docs/miniapp-hosting-vercel.md`.

Testing diagnostics mode:
- Enable with `?debug=1` in Mini App URL
- Disable with `?debug=0`

## Setup
1. Copy `.env.example` to `.env`.
2. Install deps: `npm install`.
3. Run app: `npm run dev`.
4. Apply Supabase migration from `supabase/migrations/0001_init.sql`.
5. Apply Supabase migration from `supabase/migrations/0002_v1_atomic_workflow.sql`.
6. Apply Supabase migration from `supabase/migrations/0003_v1_planning_primitives.sql`.
7. Apply Supabase migration from `supabase/migrations/0004_v1_5_voice_structured_triage.sql`.

## Access model (V0/V1)
- Use Edge Functions for all app data access.
- Keep client table access disabled by default.
- Keep AI and planning logic server-side.

## Local vs Hosted env
- Local dev:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_EDGE_BASE_URL` optional (derived automatically when omitted)
- Hosted deploy (Vercel):
  - Same env names in Vercel project settings
  - Prefer explicit `VITE_EDGE_BASE_URL=https://<project-ref>.supabase.co/functions/v1`

## Edge Functions in V1 loop
- `auth-telegram`
- `get-inbox`
- `get-projects`
- `get-notes`
- `capture-inbox`
- `ingest-voice-telegram`
- `triage-inbox-item`
- `get-tasks`
- `get-planning-assistant`
- `get-ai-advisor`
- `update-task-status`

## Deploy note for custom app session auth
- These functions use custom app sessions (`x-app-session`), not Supabase Auth JWT.
- Deploy them with JWT verification disabled, for example:
  - `supabase functions deploy get-inbox --no-verify-jwt`
  - `supabase functions deploy get-notes --no-verify-jwt`
  - `supabase functions deploy get-tasks --no-verify-jwt`

## Required Edge Function env vars
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `BOT_INGEST_TOKEN` (for bot -> voice ingest endpoint auth)
- `APP_SESSION_TTL_SECONDS` (optional, defaults to `86400`)
- `APP_SESSION_PEPPER` (optional, defaults to service role key)
- `OPENAI_API_KEY` (for AI advisor)
- `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`)
- `OPENAI_TRANSCRIBE_MODEL` (recommended: `whisper-1` for stable voice transcription)

## Smoke Test
Run lightweight integration smoke coverage (includes voice-confirm triage path, duplicate-submit conflict, and validation failures):

`npm run test:smoke`

Required shell env vars:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `EDGE_BASE_URL`
- `APP_SESSION_PEPPER` (optional)
