alter table public.projects
  add column if not exists aliases text[] not null default '{}'::text[];

update public.projects
set aliases = '{}'::text[]
where aliases is null;
