-- ============================================================
-- Create bookmakers, bet_types, and odds tables
-- Source: GET /odds/bookmakers, /odds/bets, /odds
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- TABLE: bookmakers (lookup)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmakers (
  id   integer PRIMARY KEY,
  name text    NOT NULL UNIQUE
);

COMMENT ON TABLE bookmakers IS 'Bookmaker catalog from /odds/bookmakers';

-- ─────────────────────────────────────────────────────────────
-- TABLE: bet_types (lookup)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bet_types (
  id   integer PRIMARY KEY,
  name text    NOT NULL UNIQUE
);

COMMENT ON TABLE bet_types IS 'Bet type catalog from /odds/bets';

-- ─────────────────────────────────────────────────────────────
-- TABLE: odds
-- Pre-match betting odds (7-day window before kickoff)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odds (
  id           bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id      integer         NOT NULL REFERENCES games(id),
  bookmaker_id integer         NOT NULL REFERENCES bookmakers(id),
  bet_id       integer         NOT NULL REFERENCES bet_types(id),
  bet_value    text            NOT NULL,
  odd          numeric(8,3)
);

CREATE INDEX IF NOT EXISTS idx_odds_game
  ON odds (game_id);
CREATE INDEX IF NOT EXISTS idx_odds_bookmaker
  ON odds (bookmaker_id);
CREATE INDEX IF NOT EXISTS idx_odds_bet
  ON odds (bet_id);

COMMENT ON TABLE odds IS 'Pre-match betting odds — 7-day window, bookmaker x bet type x outcome';
