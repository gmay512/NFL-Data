-- ============================================================
-- Relax game_events.event_type constraint for full API compatibility
-- ============================================================

ALTER TABLE public.game_events
  DROP CONSTRAINT IF EXISTS game_events_event_type_check;

COMMENT ON COLUMN public.game_events.event_type IS 'API-Sports event type code (e.g., TD, FG, PAT, SAF, 2PT, SF, PEN, etc.)';
