-- ============================================================
-- Extend teams and players with full schema columns
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- Extend: teams
-- Add franchise metadata fields
-- ─────────────────────────────────────────────────────────────
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS code             varchar(5)   UNIQUE,
  ADD COLUMN IF NOT EXISTS city             text,
  ADD COLUMN IF NOT EXISTS coach            text,
  ADD COLUMN IF NOT EXISTS owner            text,
  ADD COLUMN IF NOT EXISTS stadium          text,
  ADD COLUMN IF NOT EXISTS established      integer,
  ADD COLUMN IF NOT EXISTS country_name     text,
  ADD COLUMN IF NOT EXISTS country_code     char(2),
  ADD COLUMN IF NOT EXISTS country_flag_url text;

-- ─────────────────────────────────────────────────────────────
-- Extend: players
-- Add physical / biographical fields
-- ─────────────────────────────────────────────────────────────
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS age              integer,
  ADD COLUMN IF NOT EXISTS height           text,
  ADD COLUMN IF NOT EXISTS weight           text,
  ADD COLUMN IF NOT EXISTS college          text,
  ADD COLUMN IF NOT EXISTS position_group   text,
  ADD COLUMN IF NOT EXISTS position         varchar(10),
  ADD COLUMN IF NOT EXISTS jersey_number    integer,
  ADD COLUMN IF NOT EXISTS salary_bracket   text,
  ADD COLUMN IF NOT EXISTS experience_years integer;

-- Indexes for commonly-queried player fields
CREATE INDEX IF NOT EXISTS idx_players_position
  ON players (position);

CREATE INDEX IF NOT EXISTS idx_players_name
  ON players USING gin (to_tsvector('english', name));
