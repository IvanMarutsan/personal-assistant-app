begin;

create table if not exists public.calendar_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  details text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'UTC',
  source text not null check (source in ('app', 'google')),
  calendar_provider text not null default 'google',
  provider_event_id text,
  provider_event_url text,
  provider_status text,
  is_all_day boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_calendar_blocks_user_start on public.calendar_blocks(user_id, start_at);
create index if not exists idx_calendar_blocks_user_project on public.calendar_blocks(user_id, project_id);
create unique index if not exists idx_calendar_blocks_user_provider_event
  on public.calendar_blocks(user_id, calendar_provider, provider_event_id)
  where provider_event_id is not null;

drop trigger if exists trg_calendar_blocks_updated_at on public.calendar_blocks;
create trigger trg_calendar_blocks_updated_at
before update on public.calendar_blocks
for each row execute function public.touch_updated_at();

alter table public.calendar_blocks enable row level security;

commit;
