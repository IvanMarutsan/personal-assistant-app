# AI Advisor V1 (Read-Only)

`get-ai-advisor` adds an AI interpretation layer on top of the deterministic planning baseline.

## Guardrails
- Server-side only OpenAI call from Edge Function.
- Read-only recommendations only.
- No direct task mutation from AI output.
- Existing deterministic endpoints remain the baseline for actions.

## Context Sent To AI
The endpoint sends a structured JSON context containing:
- `generatedAt`, `timezone`, `currentLocalTime`
- `deterministicBaseline`:
  - priority order rules
  - suggested primary/defer task IDs from rules
- `dailyReview`:
  - completed/moved/cancelled/protected-missed counts for today
- `quickCommunicationLoad`:
  - open count
  - batching recommendation flag
- `movedReasons`:
  - top reasons today
  - top reasons across last 7 days
- `tasks`:
  - `plannedToday` (trimmed to max 15)
  - `overduePlanned` (max 15)
  - `protectedEssentialsPending` (max 15)
  - `recurringEssentialsAtRisk` (max 15)
  - Each item includes ID/title/project/type/status and core scheduling/importance metadata.

## Required AI JSON Output
The model must return strict JSON:
- `whatMattersMostNow: string`
- `suggestedNextAction: { taskId: string | null, title: string, reason: string }`
- `suggestedDefer: { taskId: string | null, title: string, reason: string }`
- `protectedEssentialsWarning: { hasWarning: boolean, message: string }`
- `explanation: string`
- `evidence: string[]`

## Fallback Behavior
If OpenAI is not configured or fails:
- Endpoint returns `source = "fallback_rules"` and `fallbackReason`.
- Advisor content is generated from deterministic rules and current context snapshot.
- UI remains functional and continues to show recommendations.
