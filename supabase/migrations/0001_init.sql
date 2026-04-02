-- Personal Assistant V1 foundation
-- Telegram-first identity, server-side access through Edge Functions.
-- Keep schema simple but event-friendly for adaptive planning.

create extension if not exists pgcrypto;

create type public.project_status as enum ('active', 'on_hold', 'archived');
create type public.task_type as enum (
  'deep_work',
  'quick_communication',
  'admin_operational',
  'recurring_essential',
  'personal_essential',
  'someday'
);
create type public.task_status as enum ('planned', 'in_progress', 'blocked', 'done', 'cancelled');
create type public.inbox_item_status as enum ('new', 'triaged', 'discarded');
create type public.capture_source_type as enum ('text', 'voice');
create type public.capture_source_channel as enum ('telegram_bot', 'mini_app');
create type public.commitment_type as enum ('flexible', 'hard');
create type public.moved_reason_code as enum (
  'reprioritized',
  'blocked_dependency',
  'urgent_interrupt',
  'calendar_conflict',
  'underestimated',
  'low_energy',
  'waiting_on_external',
  'personal_issue',
  'other'
);
create type public.task_event_type as enum (
  'created',
  'triaged_from_inbox',
  'status_changed',
  'rescheduled',
  'postponed',
  'missed',
  'completed',
  'reopened',
  'task_updated'
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  telegram_user_id bigint unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',
  planning_prefs jsonb not null default '{}'::jsonb,
  life_essentials jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  status public.project_status not null default 'active',
  rank integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  status public.inbox_item_status not null default 'new',
  source_type public.capture_source_type not null,
  source_channel public.capture_source_channel not null,
  raw_text text,
  transcript_text text,
  voice_file_id text,
  captured_at timestamptz not null default now(),
  triaged_at timestamptz,
  discarded_at timestamptz,
  meta jsonb not null default '{}'::jsonb
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  created_from_inbox_item_id uuid references public.inbox_items(id) on delete set null,
  title text not null,
  details text,
  task_type public.task_type not null default 'admin_operational',
  status public.task_status not null default 'planned',
  priority smallint not null default 3 check (priority between 1 and 5),
  importance smallint not null default 3 check (importance between 1 and 5),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes > 0),
  due_at timestamptz,
  scheduled_for timestamptz,
  commitment_type public.commitment_type not null default 'flexible',
  is_recurring boolean not null default false,
  recurrence_rule text,
  recurrence_timezone text,
  is_protected_essential boolean not null default false,
  postpone_count integer not null default 0,
  last_moved_reason public.moved_reason_code,
  calendar_provider text,
  calendar_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  event_type public.task_event_type not null,
  reason_code public.moved_reason_code,
  reason_text text,
  old_status public.task_status,
  new_status public.task_status,
  old_due_at timestamptz,
  new_due_at timestamptz,
  old_scheduled_for timestamptz,
  new_scheduled_for timestamptz,
  old_estimated_minutes integer,
  new_estimated_minutes integer,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  linked_task_id uuid references public.tasks(id) on delete set null,
  title text,
  body text not null,
  source_type public.capture_source_type,
  source_channel public.capture_source_channel,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_projects_user_status on public.projects(user_id, status);
create index if not exists idx_inbox_items_user_status on public.inbox_items(user_id, status, captured_at desc);
create index if not exists idx_tasks_user_status on public.tasks(user_id, status);
create index if not exists idx_tasks_user_due on public.tasks(user_id, due_at);
create index if not exists idx_tasks_user_sched on public.tasks(user_id, scheduled_for);
create index if not exists idx_tasks_created_from_inbox on public.tasks(created_from_inbox_item_id);
create index if not exists idx_task_events_task_created on public.task_events(task_id, created_at desc);
create index if not exists idx_task_events_user_type_created on public.task_events(user_id, event_type, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
before update on public.projects
for each row execute function public.touch_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row execute function public.touch_updated_at();

drop trigger if exists trg_notes_updated_at on public.notes;
create trigger trg_notes_updated_at
before update on public.notes
for each row execute function public.touch_updated_at();

-- Access strategy (V0/V1): server-side only through Edge Functions.
-- Keep RLS enabled but do not add anon/authenticated table policies yet.
-- Service role used by Edge Functions bypasses RLS.
alter table public.users enable row level security;
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.inbox_items enable row level security;
alter table public.tasks enable row level security;
alter table public.task_events enable row level security;
alter table public.notes enable row level security;
alter table public.app_sessions enable row level security;
