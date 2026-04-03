-- V1 calendar linkage polish: keep openable Google event URL in linkage table.

alter table public.calendar_event_links
add column if not exists provider_event_url text;
