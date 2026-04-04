ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS planning_flexibility text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tasks_planning_flexibility_valid'
  ) THEN
    ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_planning_flexibility_valid
    CHECK (
      planning_flexibility IS NULL
      OR planning_flexibility IN ('essential', 'flexible')
    );
  END IF;
END $$;
