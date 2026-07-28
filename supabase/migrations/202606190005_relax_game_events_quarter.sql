-- ============================================================
-- Relax game_events.quarter constraint for API compatibility
-- ============================================================

ALTER TABLE public.game_events
  DROP CONSTRAINT IF EXISTS game_events_quarter_check;

COMMENT ON COLUMN public.game_events.quarter IS 'Quarter label returned by API-Sports (e.g., First, Second, Third, Fourth, OT, OT2, Overtime).';
