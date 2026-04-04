alter table if exists public.planning_sessions
  drop constraint if exists planning_sessions_scope_type_check;

alter table if exists public.planning_sessions
  add constraint planning_sessions_scope_type_check
  check (scope_type in ('day', 'week'));