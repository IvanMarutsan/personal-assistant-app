-- V1 planning primitives compatibility.
-- Add `waiting_response` reason code while keeping existing enum values.

ALTER TYPE public.moved_reason_code
  ADD VALUE IF NOT EXISTS 'waiting_response';
