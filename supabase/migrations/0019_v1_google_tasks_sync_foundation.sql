alter table public.tasks
add column if not exists google_task_provider text;

alter table public.tasks
add column if not exists google_task_list_id text;

alter table public.tasks
add column if not exists google_task_id text;

alter table public.tasks
add column if not exists google_task_sync_mode text;

alter table public.tasks
add column if not exists google_task_sync_error text;

alter table public.tasks
drop constraint if exists tasks_google_task_sync_mode_check;

alter table public.tasks
add constraint tasks_google_task_sync_mode_check
check (google_task_sync_mode is null or google_task_sync_mode in ('app_managed', 'manual'));
