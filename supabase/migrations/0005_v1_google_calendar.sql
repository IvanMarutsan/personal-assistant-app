-- V1 Google Calendar integration (explicit, user-confirmed).

create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null default 'google',
  google_email text,
  access_token text not null,
  refresh_token text,
  token_type text,
  scope text,
  expires_at timestamptz,
  calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists public.calendar_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  state_hash text not null unique,
  return_path text not null default '/calendar',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null default 'google',
  provider_event_id text not null,
  inbox_item_id uuid references public.inbox_items(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  note_id uuid references public.notes(id) on delete set null,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  unique (user_id, provider, provider_event_id)
);

create index if not exists idx_calendar_connections_user on public.calendar_connections(user_id);
create index if not exists idx_calendar_oauth_states_expires on public.calendar_oauth_states(expires_at);
create index if not exists idx_calendar_event_links_user_created on public.calendar_event_links(user_id, created_at desc);

drop trigger if exists trg_calendar_connections_updated_at on public.calendar_connections;
create trigger trg_calendar_connections_updated_at
before update on public.calendar_connections
for each row execute function public.touch_updated_at();

alter table public.calendar_connections enable row level security;
alter table public.calendar_oauth_states enable row level security;
alter table public.calendar_event_links enable row level security;
