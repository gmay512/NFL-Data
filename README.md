# NFL Data Local Dashboard

Vite + React app backed by a local Supabase stack running in Docker.

## What this includes

- Supabase schema for NFL data tables:
  - `public.leagues`
  - `public.league_seasons`
  - `public.teams`
  - `public.players`
  - `public.games`
  - `public.game_events`
  - `public.injuries`
  - `public.player_season_stats`
  - `public.standings`
  - `public.game_team_stats`
  - `public.game_player_stats`
- Row Level Security (RLS) enabled on all schema tables.
- Public anon read policies plus service-role full-access policies for ingestion workflows.
- Home page and dashboard UI that queries these tables through Supabase client.
- Home page season picker that triggers a season ingest from the app UI.
- Basic API-Sports ingest script that upserts extended datasets from the CLI as a fallback.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Start local Supabase (Docker required):

```bash
npm run db:start
```

3. Use the local API URL and publishable key shown by `db:start` in a local env file:

```bash
cp .env.example .env.local
```

Then set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `API_SPORTS_KEY`

Optional ingest controls:

- `API_SPORTS_BASE_URL`
- `API_SPORTS_HOST`
- `API_SPORTS_SEASON`
- `API_SPORTS_LEAGUE_ID`

Note: the dev server reads `API_SPORTS_KEY` and also accepts the legacy mixed-case `API_Sports_KEY` name if that is already present in your env file.

4. Run the app:

```bash
npm run dev
```

## Database commands

```bash
npm run db:start   # start local Supabase stack
npm run db:stop    # stop local Supabase stack
npm run db:status  # print local Supabase status and keys
npm run db:push    # apply new migrations
npm run db:reset   # rebuild local database from migrations
```

## Ingest command

```bash
npm run ingest

```

You can override the ingest season at runtime:

```bash
npm run ingest -- --season=2024
```

If `--season` is omitted, the script falls back to `API_SPORTS_SEASON` from `.env.local`.

The home page now offers the main ingest flow. It loads available seasons from `/seasons`, then POSTs the selected season to the local dev server so the ingest runs with service-role credentials.

The CLI ingest script remains available and currently calls and upserts data from:

- `/leagues` -> `leagues`, `league_seasons`
- `/injuries` -> `injuries`
- `/players/statistics` -> `player_season_stats`
- `/standings` -> `standings`
- `/games/statistics/teams` -> `game_team_stats`
- `/games/statistics/players` -> `game_player_stats`

## Migrations

- Schema migration: `supabase/migrations/202606170001_initial_schema.sql`
- RLS migration: `supabase/migrations/202606170002_rls_policies.sql`
- Extended schema migration: `supabase/migrations/202606170003_extended_schema.sql`
- Extended RLS migration: `supabase/migrations/202606170004_extended_rls.sql`

## App routes

- `/` home page with links to schema sections
- `/dashboard` data dashboard with snapshots across all 11 schema tables
