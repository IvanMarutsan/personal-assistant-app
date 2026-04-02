# V1 foundation migration plan

## If migration `0001_init.sql` has NOT been applied yet
Use the new `0001_init.sql` directly.
Then apply `0002_v1_atomic_workflow.sql`.

## If old V0 schema is already deployed
Create a follow-up migration (e.g. `0002_v1_refactor.sql`) with these steps:
1. Drop old auth.uid()-based RLS policies.
2. Add `users.auth_user_id` nullable unique column.
3. Rename `inbox_status` -> `inbox_item_status` if needed.
4. Add new enums (`capture_source_type`, `capture_source_channel`, `commitment_type`, `moved_reason_code`, `task_event_type`).
5. Expand `task_type` enum values to V1 set.
6. Remove `inbox` from `task_status` (recreate enum + cast if currently present).
7. Drop `inbox_items.created_task_id` to remove cyclic linkage.
8. Add `tasks.created_from_inbox_item_id` if missing and backfill from old relation if needed.
9. Add fields for planning analytics (`importance`, `estimated_minutes`, `commitment_type`, `postpone_count`, `last_moved_reason`).
10. Add inbox source tracking fields (`source_type`, `source_channel`, `transcript_text`, `meta`).
11. Keep RLS enabled but no anon/authenticated table policies.
