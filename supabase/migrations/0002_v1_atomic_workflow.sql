-- V1 hardening: atomic inbox triage + atomic task status updates.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'task_event_actor_type'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.task_event_actor_type AS ENUM ('user', 'system', 'ai');
  END IF;
END
$$;

ALTER TABLE public.task_events
  ADD COLUMN IF NOT EXISTS actor_type public.task_event_actor_type NOT NULL DEFAULT 'user';

CREATE OR REPLACE FUNCTION public.triage_inbox_item_atomic(
  p_user_id uuid,
  p_inbox_item_id uuid,
  p_action text,
  p_title text DEFAULT NULL,
  p_details text DEFAULT NULL,
  p_note_body text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_inbox public.inbox_items%ROWTYPE;
  v_now timestamptz := now();
  v_task_id uuid;
  v_note_id uuid;
  v_note_text text;
  v_task_title text;
BEGIN
  SELECT *
  INTO v_inbox
  FROM public.inbox_items
  WHERE id = p_inbox_item_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inbox_item_not_found';
  END IF;

  IF v_inbox.status <> 'new' THEN
    RAISE EXCEPTION 'inbox_item_not_new';
  END IF;

  IF p_action = 'discard' THEN
    UPDATE public.inbox_items
    SET status = 'discarded',
        discarded_at = v_now
    WHERE id = v_inbox.id
      AND user_id = p_user_id;

    RETURN jsonb_build_object(
      'action', 'discard',
      'inbox_item_id', v_inbox.id
    );
  END IF;

  IF p_action = 'note' THEN
    v_note_text := COALESCE(
      NULLIF(BTRIM(p_note_body), ''),
      NULLIF(BTRIM(v_inbox.raw_text), ''),
      NULLIF(BTRIM(v_inbox.transcript_text), '')
    );

    IF v_note_text IS NULL THEN
      RAISE EXCEPTION 'empty_note_body';
    END IF;

    INSERT INTO public.notes (
      user_id,
      project_id,
      title,
      body,
      source_type,
      source_channel
    )
    VALUES (
      p_user_id,
      v_inbox.project_id,
      NULL,
      v_note_text,
      v_inbox.source_type,
      v_inbox.source_channel
    )
    RETURNING id INTO v_note_id;

    UPDATE public.inbox_items
    SET status = 'triaged',
        triaged_at = v_now
    WHERE id = v_inbox.id
      AND user_id = p_user_id;

    RETURN jsonb_build_object(
      'action', 'note',
      'inbox_item_id', v_inbox.id,
      'note_id', v_note_id
    );
  END IF;

  IF p_action = 'task' THEN
    v_task_title := COALESCE(
      NULLIF(BTRIM(p_title), ''),
      LEFT(
        COALESCE(
          NULLIF(BTRIM(v_inbox.raw_text), ''),
          NULLIF(BTRIM(v_inbox.transcript_text), ''),
          'Untitled task'
        ),
        120
      )
    );

    INSERT INTO public.tasks (
      user_id,
      project_id,
      created_from_inbox_item_id,
      title,
      details,
      task_type,
      status
    )
    VALUES (
      p_user_id,
      v_inbox.project_id,
      v_inbox.id,
      v_task_title,
      NULLIF(BTRIM(p_details), ''),
      'admin_operational',
      'planned'
    )
    RETURNING id INTO v_task_id;

    INSERT INTO public.task_events (
      task_id,
      user_id,
      event_type,
      actor_type,
      payload
    )
    VALUES (
      v_task_id,
      p_user_id,
      'triaged_from_inbox',
      'user',
      jsonb_build_object('inbox_item_id', v_inbox.id)
    );

    UPDATE public.inbox_items
    SET status = 'triaged',
        triaged_at = v_now
    WHERE id = v_inbox.id
      AND user_id = p_user_id;

    RETURN jsonb_build_object(
      'action', 'task',
      'inbox_item_id', v_inbox.id,
      'task_id', v_task_id
    );
  END IF;

  RAISE EXCEPTION 'invalid_action';
END;
$$;

CREATE OR REPLACE FUNCTION public.update_task_status_atomic(
  p_user_id uuid,
  p_task_id uuid,
  p_new_status public.task_status,
  p_reason_code public.moved_reason_code DEFAULT NULL,
  p_reason_text text DEFAULT NULL,
  p_new_due_at timestamptz DEFAULT NULL,
  p_new_scheduled_for timestamptz DEFAULT NULL,
  p_event_hint text DEFAULT NULL,
  p_postpone_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_task public.tasks%ROWTYPE;
  v_now timestamptz := now();
  v_event_type public.task_event_type;
  v_due_at timestamptz;
  v_scheduled_for timestamptz;
BEGIN
  SELECT *
  INTO v_task
  FROM public.tasks
  WHERE id = p_task_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found';
  END IF;

  v_due_at := COALESCE(p_new_due_at, v_task.due_at);

  IF p_event_hint = 'postponed' THEN
    v_scheduled_for := COALESCE(
      p_new_scheduled_for,
      COALESCE(v_task.scheduled_for, v_now)
        + make_interval(mins => COALESCE(NULLIF(p_postpone_minutes, 0), 1440))
    );
  ELSE
    v_scheduled_for := COALESCE(p_new_scheduled_for, v_task.scheduled_for);
  END IF;

  v_event_type := CASE
    WHEN p_event_hint = 'postponed' THEN 'postponed'
    WHEN p_event_hint = 'rescheduled' THEN 'rescheduled'
    WHEN p_new_status = 'done' AND v_task.status <> 'done' THEN 'completed'
    WHEN p_new_status <> v_task.status THEN 'status_changed'
    ELSE 'task_updated'
  END;

  UPDATE public.tasks
  SET status = p_new_status,
      due_at = v_due_at,
      scheduled_for = v_scheduled_for,
      completed_at = CASE WHEN p_new_status = 'done' THEN v_now ELSE NULL END,
      last_moved_reason = COALESCE(p_reason_code, last_moved_reason),
      postpone_count = CASE
        WHEN v_event_type = 'postponed' THEN COALESCE(postpone_count, 0) + 1
        ELSE postpone_count
      END
  WHERE id = v_task.id
    AND user_id = p_user_id;

  INSERT INTO public.task_events (
    task_id,
    user_id,
    event_type,
    actor_type,
    reason_code,
    reason_text,
    old_status,
    new_status,
    old_due_at,
    new_due_at,
    old_scheduled_for,
    new_scheduled_for,
    old_estimated_minutes,
    new_estimated_minutes,
    payload
  )
  VALUES (
    v_task.id,
    p_user_id,
    v_event_type,
    'user',
    p_reason_code,
    NULLIF(BTRIM(p_reason_text), ''),
    v_task.status,
    p_new_status,
    v_task.due_at,
    v_due_at,
    v_task.scheduled_for,
    v_scheduled_for,
    v_task.estimated_minutes,
    v_task.estimated_minutes,
    jsonb_build_object('event_hint', COALESCE(p_event_hint, 'none'))
  );

  RETURN jsonb_build_object(
    'task_id', v_task.id,
    'event_type', v_event_type,
    'new_status', p_new_status,
    'new_due_at', v_due_at,
    'new_scheduled_for', v_scheduled_for
  );
END;
$$;
