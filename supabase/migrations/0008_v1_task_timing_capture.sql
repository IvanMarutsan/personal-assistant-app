-- Task Timing Capture V1: allow inbox triage task creation to persist estimated minutes.

CREATE OR REPLACE FUNCTION public.triage_inbox_item_atomic(
  p_user_id uuid,
  p_inbox_item_id uuid,
  p_action text,
  p_title text DEFAULT NULL,
  p_details text DEFAULT NULL,
  p_note_body text DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_task_type public.task_type DEFAULT NULL,
  p_importance smallint DEFAULT NULL,
  p_due_at timestamptz DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT NULL,
  p_estimated_minutes integer DEFAULT NULL
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
  v_project_id uuid;
  v_task_type public.task_type;
  v_importance smallint;
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

  IF p_estimated_minutes IS NOT NULL AND p_estimated_minutes <= 0 THEN
    RAISE EXCEPTION 'invalid_estimated_minutes';
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
      COALESCE(p_project_id, v_inbox.project_id),
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

    IF p_project_id IS NOT NULL THEN
      PERFORM 1
      FROM public.projects
      WHERE id = p_project_id
        AND user_id = p_user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'project_not_found';
      END IF;
    END IF;

    v_project_id := COALESCE(p_project_id, v_inbox.project_id);
    v_task_type := COALESCE(p_task_type, 'admin_operational'::public.task_type);
    v_importance := COALESCE(p_importance, 3);

    IF v_importance < 1 OR v_importance > 5 THEN
      RAISE EXCEPTION 'invalid_importance';
    END IF;

    INSERT INTO public.tasks (
      user_id,
      project_id,
      created_from_inbox_item_id,
      title,
      details,
      task_type,
      status,
      importance,
      due_at,
      scheduled_for,
      estimated_minutes
    )
    VALUES (
      p_user_id,
      v_project_id,
      v_inbox.id,
      v_task_title,
      NULLIF(BTRIM(p_details), ''),
      v_task_type,
      'planned',
      v_importance,
      p_due_at,
      p_scheduled_for,
      p_estimated_minutes
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
      jsonb_build_object(
        'inbox_item_id', v_inbox.id,
        'project_id', v_project_id,
        'task_type', v_task_type,
        'importance', v_importance,
        'due_at', p_due_at,
        'scheduled_for', p_scheduled_for,
        'estimated_minutes', p_estimated_minutes
      )
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
