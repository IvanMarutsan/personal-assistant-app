create table if not exists public.planning_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  scope_type text not null check (scope_type in ('day')),
  scope_date date not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, scope_type, scope_date)
);

create table if not exists public.planning_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.planning_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.planning_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.planning_sessions(id) on delete cascade,
  assistant_message_id uuid references public.planning_messages(id) on delete set null,
  task_id uuid not null references public.tasks(id) on delete cascade,
  proposal_type text not null check (proposal_type in ('task_patch')),
  payload jsonb not null default '{}'::jsonb,
  rationale text,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'dismissed', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_planning_sessions_user_scope on public.planning_sessions(user_id, scope_type, scope_date desc);
create index if not exists idx_planning_messages_session_created on public.planning_messages(session_id, created_at asc);
create index if not exists idx_planning_proposals_session_created on public.planning_proposals(session_id, created_at asc);
create index if not exists idx_planning_proposals_status on public.planning_proposals(session_id, status, created_at desc);

drop trigger if exists trg_planning_sessions_updated_at on public.planning_sessions;
create trigger trg_planning_sessions_updated_at
before update on public.planning_sessions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_planning_proposals_updated_at on public.planning_proposals;
create trigger trg_planning_proposals_updated_at
before update on public.planning_proposals
for each row execute function public.touch_updated_at();
