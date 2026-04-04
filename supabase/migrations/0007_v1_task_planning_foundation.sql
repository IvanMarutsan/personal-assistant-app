-- V1 task planning foundation alignment.
-- Keep the schema idempotent so older databases can safely adopt the current task planning fields.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimated_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname = 'tasks_estimated_minutes_positive'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_estimated_minutes_positive
      CHECK (estimated_minutes IS NULL OR estimated_minutes > 0);
  END IF;
END
$$;
