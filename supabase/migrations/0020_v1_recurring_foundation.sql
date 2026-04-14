begin;

alter table public.tasks
  add column if not exists recurrence_origin_task_id uuid references public.tasks(id) on delete set null;

create index if not exists idx_tasks_user_recurring on public.tasks(user_id, is_recurring);
create index if not exists idx_tasks_recurrence_origin on public.tasks(recurrence_origin_task_id);

alter table public.calendar_blocks
  add column if not exists is_recurring boolean not null default false,
  add column if not exists recurrence_rule text,
  add column if not exists recurrence_timezone text,
  add column if not exists recurrence_parent_provider_event_id text;

create index if not exists idx_calendar_blocks_user_recurring on public.calendar_blocks(user_id, is_recurring);
create index if not exists idx_calendar_blocks_user_recurrence_parent
  on public.calendar_blocks(user_id, recurrence_parent_provider_event_id)
  where recurrence_parent_provider_event_id is not null;

commit;
