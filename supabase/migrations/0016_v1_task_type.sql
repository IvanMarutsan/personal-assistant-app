do $$ begin
  alter type public.task_type add value if not exists 'communication';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'publishing';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'admin';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'planning';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'tech';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'content';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'meeting';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.task_type add value if not exists 'review';
exception when duplicate_object then null;
end $$;
