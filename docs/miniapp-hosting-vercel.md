# Mini App Hosting (Vercel-first)

## Why Vercel
- Fast static hosting for Vite output.
- Native HTTPS URL for Telegram Mini App.
- Simple env configuration per environment.
- Works well with SPA routing via `vercel.json` rewrite.

## 1. Prepare app repo
- Ensure `vercel.json` exists with SPA rewrite:
  - all paths -> `/index.html`
- Ensure build command is `npm run build`.

## 2. Vercel project setup
1. Import `personal-assistant-app` repository in Vercel.
2. Framework preset: `Vite`.
3. Build command: `npm run build`.
4. Output directory: `dist`.

## 3. Required Vercel env vars
- `VITE_SUPABASE_URL=https://<project-ref>.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<publishable anon key>`
- `VITE_EDGE_BASE_URL=https://<project-ref>.supabase.co/functions/v1` (recommended explicit)

## 4. Telegram bot connection
- Set bot env:
  - `MINI_APP_URL=https://<your-vercel-domain>`
- Restart bot after env change.

Important: always press **Open App** from a fresh `/start` message after URL changes.

## 5. Local development (still supported)
- Run app: `npm run dev -- --host`
- Optional tunnel for phone testing:
  - ngrok/cloudflared URL
- In local testing only, temporarily set bot `MINI_APP_URL` to tunnel URL.

## 6. Switch strategy (hosted vs local)
- Stable UX testing:
  - Keep `MINI_APP_URL` on hosted Vercel domain.
- Debug local UI changes:
  - Temporarily switch `MINI_APP_URL` to tunnel.
  - Switch back to hosted URL after debugging.

## 7. Deployment validation checklist
1. Open hosted URL in desktop browser.
2. Open `/today` and `/tasks` directly (route rewrite check).
3. In Telegram: `/start` -> `Open App`.
4. Confirm `auth-telegram` session is created.
5. Confirm Inbox loads for Telegram user.
6. Send voice; confirm item appears and can be triaged.
7. Confirm `get-inbox`, `triage-inbox-item`, `get-projects` are reachable from hosted app.
8. Confirm no `localhost` or tunnel URL left in bot env for stable testing.
