# V1 schema notes

## Inbox vs tasks separation
- `inbox_items` is the raw capture queue (`status`: `new`, `triaged`, `discarded`).
- `tasks` is actionable work only (`status`: `planned`, `in_progress`, `blocked`, `done`, `cancelled`).
- `task_status` does not include `inbox`.

## Inbox-task linkage
Single direction only:
- `tasks.created_from_inbox_item_id -> inbox_items.id`

No reverse foreign key on `inbox_items` to avoid cyclic coupling.

## Why moved and missed analysis
Use `task_events` with structured fields:
- `event_type` (`rescheduled`, `postponed`, `missed`, etc.)
- `actor_type` (`user`, `system`, `ai`)
- `reason_code` + `reason_text`
- old/new due/schedule/status snapshots

`tasks.postpone_count` and `tasks.last_moved_reason` are fast-access summary fields.

For V1 UI, preferred move reasons:
- `reprioritized`
- `urgent_interrupt`
- `low_energy`
- `waiting_response`
- `underestimated`
- `blocked_dependency`
- `calendar_conflict`
- `personal_issue`
- `other`

## Future planning and calendar
Keep lightweight placeholders on `tasks`:
- `calendar_provider`
- `calendar_event_id`

No full calendar sync model in V1.
