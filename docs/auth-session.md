# V1 access model and session strategy

## Core decision
For V0/V1, read/write access goes through Edge Functions only.

- Mini App does not read/write tables directly.
- Telegram bot writes through server credentials (service role) or calls Edge Functions.
- RLS remains enabled with no client-facing table policies yet.

## Identity model
- `users.id` is internal UUID (primary key for domain data).
- `users.telegram_user_id` is the primary real-world identity now.
- `users.auth_user_id` is nullable and reserved for later Supabase Auth mapping.

## Session flow
1. Mini App sends `Telegram.WebApp.initData` to `auth-telegram`.
2. `auth-telegram` verifies signature using bot token.
3. Function upserts `users` + `profiles` by `telegram_user_id`.
4. Function creates session token, stores hash in `app_sessions`, returns token.
5. Mini App sends token to subsequent Edge Functions.
6. App includes token in `x-app-session` header for `get-inbox`, `capture-inbox`, and `triage-inbox-item`.

## Why this is cleaner now
- Avoids invalid `auth.uid() == users.id` assumptions.
- Keeps Telegram-first onboarding simple.
- Preserves a migration path to Supabase Auth later.
