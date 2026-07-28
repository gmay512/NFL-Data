-- ============================================================
-- RLS policies for bookmakers, bet_types, and odds tables
-- ============================================================

ALTER TABLE bookmakers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bet_types  ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds       ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON bookmakers, bet_types, odds TO anon, authenticated;
GRANT ALL ON bookmakers, bet_types, odds TO service_role;

-- bookmakers: read-only for anon/authenticated, full access for service_role
CREATE POLICY "bookmakers_select_public"
  ON bookmakers FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "bookmakers_all_service_role"
  ON bookmakers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- bet_types: read-only for anon/authenticated, full access for service_role
CREATE POLICY "bet_types_select_public"
  ON bet_types FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "bet_types_all_service_role"
  ON bet_types FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- odds: read-only for anon/authenticated, full access for service_role
CREATE POLICY "odds_select_public"
  ON odds FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "odds_all_service_role"
  ON odds FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
