# personal-assistant-app

React Mini App scaffold for Personal Assistant.

## Setup
1. Copy `.env.example` to `.env`.
2. Install deps: `npm install`.
3. Run app: `npm run dev`.
4. Apply Supabase migration from `supabase/migrations/0001_init.sql`.
5. Apply Supabase migration from `supabase/migrations/0002_v1_atomic_workflow.sql`.
6. Apply Supabase migration from `supabase/migrations/0003_v1_planning_primitives.sql`.

## Access model (V0/V1)
- Use Edge Functions for all app data access.
- Keep client table access disabled by default.
- Keep AI and planning logic server-side.

## Edge Functions in V1 loop
- `auth-telegram`
- `get-inbox`
- `capture-inbox`
- `triage-inbox-item`
- `get-tasks`
- `get-planning-assistant`
- `get-ai-advisor`
- `update-task-status`

## Required Edge Function env vars
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `APP_SESSION_TTL_SECONDS` (optional, defaults to `86400`)
- `APP_SESSION_PEPPER` (optional, defaults to service role key)
- `OPENAI_API_KEY` (for AI advisor)
- `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`)

## Smoke Test
Run lightweight integration smoke coverage:

`npm run test:smoke`

Required shell env vars:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `EDGE_BASE_URL`
- `APP_SESSION_PEPPER` (optional)
