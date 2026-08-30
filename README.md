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
  - `public.bookmakers`
  - `public.bet_types`
  - `public.odds`
- Row Level Security (RLS) enabled on all schema tables.
- Public anon read policies plus service-role full-access policies for ingestion workflows.
- Dashboard UI that queries these tables through the Supabase client.
- Dashboard season picker that loads an API-Sports season on demand when it is not yet stored locally.
- Shared API-Sports ingestion engine used by both the app server and the CLI fallback.

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
- `API_SPORTS_REQUESTS_PER_MINUTE` (defaults to 240)

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

The dashboard is the main ingest flow. It loads available seasons from `/seasons`; when the selected season has no local games, the dashboard offers a button that POSTs the season to the local dev server so the documented API-Sports endpoints are ingested with service-role credentials.

The CLI entry point is a thin adapter over the same ingestion engine used by the app server. It currently calls and upserts data from:

- `/leagues` -> `leagues`, `league_seasons`
- `/injuries` -> `injuries`
- `/players/statistics` -> `player_season_stats`
- `/standings` -> `standings`
- `/games/statistics/teams` -> `game_team_stats`
- `/games/statistics/players` -> `game_player_stats`
- `/odds/bookmakers` -> `bookmakers`
- `/odds/bets` -> `bet_types`
- `/odds?game={id}` -> timestamped `odds` snapshots

API-Sports can expose pre-match odds roughly 1–14 days before kickoff and
retains a limited seven-day history. The production server checks immediately
at startup and every hour afterward. Each run requests every upcoming game
within 14 days so new and updated lines are captured, plus games from the prior
seven days that still have no usable spread or total. The generic bookmaker,
bet type, outcome, and decimal-odds model
captures all markets returned by the provider, including moneylines, spreads,
totals, period and team markets, and player props. Re-running an unchanged
provider snapshot is idempotent; a later provider update is retained as line
history. The `game_consensus_odds` view selects each bookmaker's latest,
most-balanced full-game spread and total, then exposes their medians to the
schedule and game-detail UI without bookmaker identities or decimal prices.

Set `ODDS_AUTO_REFRESH_ENABLED=false` to disable the production scheduler.
`ODDS_REFRESH_INTERVAL_MINUTES` overrides its 60-minute cadence. Visible
schedule and pregame detail pages re-read stored consensus odds every five
minutes; those UI reads do not call API-Sports.

Odds can be refreshed without running the full season ingest:

```text
POST /api/refresh-season-odds
{"season": 2026}
```

The current API requires team-scoped requests for injuries and player season
statistics, and game-scoped requests for team and player box scores. The ingest
engine performs those requests with bounded concurrency and a shared request
pacer, then reports attempted, succeeded, failed, and upserted counts. Injury
rows retain first-seen, last-seen, and resolved timestamps so status changes
remain available as history.

These database-only collectors can also be run independently:

```text
POST /api/refresh-current-injuries
{"season": 2026}

POST /api/refresh-season-statistics
{"season": 2026}
```

`/timezone` is configuration data and `/status` contains account quota data, so
they are intentionally not persisted with NFL domain records.

The production-only historical runner fills missing 2020–2026 resources, records
complete and provider-empty checkpoints, preserves season team membership in
`team_rosters`, and stops before the configured API daily ceiling:

```bash
npm run backfill -- --dry-run
npm run backfill -- --confirm-production
```

Use `--start-season`, `--end-season`, `--daily-ceiling`, and `--verbose-plan` to
override the safe defaults. The runtime refuses mutating runs against the known
local Supabase address.

## Migrations

- Schema migration: `supabase/migrations/202606170001_initial_schema.sql`
- RLS migration: `supabase/migrations/202606170002_rls_policies.sql`
- Extended schema migration: `supabase/migrations/202606170003_extended_schema.sql`
- Extended RLS migration: `supabase/migrations/202606170004_extended_rls.sql`

## App routes

- `/` dashboard with season, week, game, and live-game views
- `/games/:id` game detail and score breakdown
- `/games/:gameId/teams/:teamId` team box score and player statistics

## Production deployment

The production target defaults to `glenn@192.168.4.237`. It expects the self-hosted
Supabase Compose project at `/home/glenn/srv/supabase-project`. The app uses host
networking for outbound DNS but listens only on `127.0.0.1:3000`; nginx is the LAN
entry point.

Apply new database migrations, then deploy or update the app:

```bash
./scripts/deploy-schema.sh
./scripts/deploy.sh
```

The first production setup also needs a one-time copy of the local public-schema data:

```bash
./scripts/seed-production-db.sh
```

The seed command refuses to run after production contains data. App secrets are written
only to `/home/glenn/srv/nfl-data/deploy/.env.production` on the server with mode `0600`.

After production has been verified, replace local public data with its snapshot:

```bash
./scripts/sync-production-to-local.sh --confirm production-to-local
```

The sync resets local migrations, streams the production data without a dump file,
and fails unless every public table has the same exact row count.

The server's nginx site should use `deploy/nginx.conf`. It serves the web app at
`http://192.168.4.237`, proxies Supabase API paths to Kong, and limits access to
`192.168.4.0/24`. Installing or changing that site requires sudo:

```bash
sudo cp /home/glenn/srv/nfl-data/deploy/nginx.conf /etc/nginx/sites-available/supabase
sudo nginx -t
sudo systemctl reload nginx
```
