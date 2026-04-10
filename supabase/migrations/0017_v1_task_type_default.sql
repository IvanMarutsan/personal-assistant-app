alter table public.tasks alter column task_type set default 'admin';

update public.tasks
set task_type = 'admin'
where task_type = 'admin_operational';
