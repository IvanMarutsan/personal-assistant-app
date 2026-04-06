alter table public.tasks
add column if not exists calendar_sync_mode text;

alter table public.tasks
add column if not exists calendar_sync_error text;

update public.tasks
set calendar_sync_mode = 'manual'
where calendar_event_id is not null
  and calendar_sync_mode is null;

alter table public.tasks
drop constraint if exists tasks_calendar_sync_mode_check;

alter table public.tasks
add constraint tasks_calendar_sync_mode_check
check (calendar_sync_mode is null or calendar_sync_mode in ('app_managed', 'manual'));
