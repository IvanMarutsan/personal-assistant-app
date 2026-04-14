begin;

alter table public.calendar_connections
  add column if not exists selected_calendar_ids text[] not null default array['primary']::text[],
  add column if not exists default_calendar_id text not null default 'primary',
  add column if not exists default_task_list_id text not null default '@default';

update public.calendar_connections
set
  selected_calendar_ids = case
    when selected_calendar_ids is null or cardinality(selected_calendar_ids) = 0
      then array[coalesce(calendar_id, default_calendar_id, 'primary')]::text[]
    else selected_calendar_ids
  end,
  default_calendar_id = coalesce(nullif(default_calendar_id, ''), nullif(calendar_id, ''), 'primary'),
  default_task_list_id = coalesce(nullif(default_task_list_id, ''), '@default');

alter table public.tasks
  add column if not exists calendar_provider_calendar_id text;

alter table public.calendar_event_links
  add column if not exists provider_calendar_id text not null default 'primary';

alter table public.calendar_blocks
  add column if not exists provider_calendar_id text not null default 'primary';

update public.tasks t
set calendar_provider_calendar_id = coalesce(cc.default_calendar_id, cc.calendar_id, 'primary')
from public.calendar_connections cc
where cc.user_id = t.user_id
  and cc.provider = 'google'
  and t.calendar_provider = 'google'
  and t.calendar_event_id is not null
  and t.calendar_provider_calendar_id is null;

update public.calendar_event_links l
set provider_calendar_id = coalesce(cc.default_calendar_id, cc.calendar_id, 'primary')
from public.calendar_connections cc
where cc.user_id = l.user_id
  and cc.provider = 'google'
  and (l.provider_calendar_id is null or l.provider_calendar_id = '');

update public.calendar_blocks b
set provider_calendar_id = coalesce(cc.default_calendar_id, cc.calendar_id, 'primary')
from public.calendar_connections cc
where cc.user_id = b.user_id
  and cc.provider = 'google'
  and (b.provider_calendar_id is null or b.provider_calendar_id = '');

drop index if exists public.idx_calendar_event_links_user_provider_event;
create unique index if not exists idx_calendar_event_links_user_provider_calendar_event
  on public.calendar_event_links(user_id, provider, provider_calendar_id, provider_event_id);

drop index if exists public.idx_calendar_blocks_user_provider_event;
create unique index if not exists idx_calendar_blocks_user_provider_calendar_event
  on public.calendar_blocks(user_id, calendar_provider, provider_calendar_id, provider_event_id)
  where provider_event_id is not null;

create index if not exists idx_calendar_blocks_user_provider_calendar_start
  on public.calendar_blocks(user_id, provider_calendar_id, start_at);

commit;
