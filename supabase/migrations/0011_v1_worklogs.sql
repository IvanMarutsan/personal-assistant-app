create table if not exists public.worklogs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  body text not null,
  occurred_at timestamptz not null default now(),
  source text,
  meta jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_worklogs_user_occurred_at on public.worklogs(user_id, occurred_at desc, created_at desc);

drop trigger if exists trg_worklogs_updated_at on public.worklogs;
create trigger trg_worklogs_updated_at
before update on public.worklogs
for each row execute function public.touch_updated_at();

alter table public.worklogs enable row level security;
