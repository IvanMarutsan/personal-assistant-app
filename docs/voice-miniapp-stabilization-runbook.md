# Voice Mini App Stabilization Runbook

## 1. Local process order
1. Start Mini App:
   - `npm run dev -- --host`
2. Start HTTPS tunnel to `http://localhost:5173` (ngrok/cloudflared).
3. Update bot `MINI_APP_URL` to active tunnel URL.
4. Restart bot.
5. Use fresh `/start` message and press **Open App**.

## 2. Vite host allowlist
- `vite.config.ts` allows:
  - `.trycloudflare.com`
  - `.ngrok-free.app`
  - `.ngrok-free.dev`

If Telegram mini app shows "Blocked request ... host is not allowed", restart Vite after updating host list.

## 3. Supabase function deployment mode
All app functions rely on custom app session headers, not Supabase JWT auth headers.
Deploy with `--no-verify-jwt`, e.g.:

`supabase functions deploy ingest-voice-telegram --no-verify-jwt`

## 4. Required backend secrets
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `BOT_INGEST_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TRANSCRIBE_MODEL` (`whisper-1` recommended)

## 5. Voice failure diagnosis
Check latest voice records:

```sql
select
  i.id,
  i.captured_at,
  i.transcript_text,
  i.meta->'voice_ai'->'transcript'->>'status' as transcript_status,
  i.meta->'voice_ai'->'transcript'->>'error' as transcript_error,
  i.meta->'voice_ai'->'parse'->>'status' as parse_status,
  i.meta->'voice_ai'->'parse'->>'error' as parse_error
from public.inbox_items i
order by i.captured_at desc
limit 20;
```

Typical signals:
- `transcription_request_failed:*` => OpenAI auth/model/billing issue or endpoint response error
- `parse_request_failed:*` => parse model call failed
- `transcript_unavailable` => parse skipped because transcription failed

## 6. Manual smoke flow
1. Send `/inbox test`.
2. Send voice message.
3. In Mini App Inbox confirm one voice item to task.
4. Confirm one voice item to note.
5. Verify triaged items are removed from Inbox.
6. Verify created task/note rows exist in DB.

## 7. Diagnostics mode for testing
- Enable debug mode:
  - append `?debug=1` to Mini App URL once
  - example: `https://mini-app.example.com/?debug=1`
- Disable debug mode:
  - open URL with `?debug=0`
- In debug mode, use **Діагностика тестування** panel:
  - `Скопіювати діагностику`
  - `Повідомити про проблему`

Send copied report text after failed tests. It includes route, environment, last action, last failed request.

## 8. Intentionally excluded diagnostics data
- No raw session tokens
- No API keys
- No secret headers
- No sensitive payload dumps
