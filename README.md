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

The analytics API requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
It does not require API-Sports credentials when it is only reading data that
has already been ingested.

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

## Analytics and local llama.cpp

The `/analytics` route provides deterministic historical results, team trends,
saved analysis sessions, and grounded model conversations. Calculations are
performed by the app before a prompt is sent to the model. llama.cpp receives a
bounded JSON snapshot and explains it; it does not receive database credentials,
SQL access, or a tool that can change application data.

Apply the analytics migrations before opening the page:

```bash
npm run db:push
```

Start an OpenAI-compatible llama.cpp server in a separate terminal. This example
matches the app defaults; replace the model path with the local GGUF file:

```bash
llama-server \
  --model /path/to/model.gguf \
  --alias qwen3-coder-next \
  --host 127.0.0.1 \
  --port 8089 \
  --ctx-size 131072
```

Confirm that the configured alias is advertised before starting the app:

```bash
curl --fail http://127.0.0.1:8089/v1/models
npm run dev
curl --fail http://127.0.0.1:5173/api/analytics/llm-health
```

The model ID returned by `/v1/models` must exactly match `LLM_MODEL`. The app
reads these server-only settings from `.env.local`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://127.0.0.1:8089` | llama.cpp OpenAI-compatible base URL |
| `LLM_MODEL` | `qwen3-coder-next` | Model ID or llama.cpp `--alias` |
| `LLM_TIMEOUT_MS` | `120000` | Request timeout, from 100 through 600000 ms |
| `LLM_MAX_CONTEXT_CHARS` | `240000` | Maximum serialized analytics context, from 10000 through 2000000 characters |
| `LLM_MAX_OUTPUT_TOKENS` | `2048` | Completion limit, from 64 through 32768 tokens |
| `LLM_MAX_HISTORY_MESSAGES` | `12` | Recent saved messages included in a follow-up, from 0 through 100 |
| `LLM_MAX_HISTORY_CHARS` | `24000` | Combined follow-up history limit, from 0 through 500000 characters |

`LLM_MAX_CONTEXT_CHARS` is an application payload guard, not the llama.cpp token
context. Keep the llama.cpp `--ctx-size` large enough for the bounded snapshot,
conversation history, and requested output. Restart the Vite or production
server after changing environment variables.

### Betting-result definitions

Closing consensus uses each bookmaker's latest valid full-game market snapshot
at or before kickoff, then takes the median line across those bookmakers.
Post-kickoff snapshots are excluded.

- Spread delta is `home final score - away final score + closing home spread`.
  A positive value is a home cover, a negative value is an away cover, and zero
  is a push.
- Total delta is `final combined score - closing total`. A positive value is an
  over, a negative value is an under, and zero is a push.
- Cover and over rates exclude pushes and ungraded games. Average deltas exclude
  missing lines.
- Completed `FT` and `AOT` games use their recorded final scores, including
  overtime. A completed game without a valid pre-kickoff spread or total remains
  visible and is marked ungraded rather than inferred.
- Injury context contains current active records. It is not presented as the
  historical injury state at the time of a past game.

The page reports missing lines, missing required team statistics, and bounded or
truncated collections in its deterministic snapshot. Saved sessions retain that
immutable snapshot so later follow-ups use the same grounding data.

### Availability and failure behavior

The historical tables and filters continue to work when llama.cpp is stopped,
unreachable, timed out, or serving a different model. The page reports the local
model as offline and disables new model requests; existing saved analyses remain
readable. A failed or cancelled completion is not stored as a successful
exchange. Start llama.cpp with the configured model and retry when health is
available.

All browser requests go to this app's `/api/analytics` routes. The browser never
connects directly to llama.cpp.

The production topology uses:

- application host: `192.168.4.237`;
- llama.cpp host: `192.168.4.241`;
- private model endpoint: `http://192.168.4.241:8089`.

On `192.168.4.241`, start llama.cpp manually with one IPv4 listener for both
loopback and LAN requests:

```bash
llama-server \
  --model /path/to/model.gguf \
  --alias qwen3-coder-next \
  --host 0.0.0.0 \
  --port 8089 \
  --ctx-size 131072
```

Binding to `127.0.0.1` would make the model unreachable from production.
Binding to `0.0.0.0` lets local clients continue using
`http://127.0.0.1:8089` while production uses
`http://192.168.4.241:8089`. Because it listens on every IPv4 interface, keep
UFW enabled and permit only the application host:

```bash
sudo ufw allow proto tcp \
  from 192.168.4.237 \
  to 192.168.4.241 port 8089 \
  comment 'NFL analytics llama.cpp'
sudo ufw status numbered
```

The production app uses host networking and can route directly to the private
LAN address, so Docker Compose does not need another network and nginx must not
proxy port 8089. CORS configuration is also unnecessary because the Node server,
not the browser, is the LLM client.

Set the endpoint in `.env.local` before deploying:

```text
LLM_BASE_URL=http://192.168.4.241:8089
LLM_MODEL=qwen3-coder-next
```

`scripts/deploy.sh` copies `LLM_*` values from `.env.local` into the protected
production environment. Shell variables passed to the deploy command take
precedence, and the deployment-specific fallback is the remote endpoint above.

After starting llama.cpp, verify the route from the application host and from
inside the app container:

```bash
curl --fail http://192.168.4.241:8089/v1/models
docker exec nfl-data-app node -e \
  "fetch('http://192.168.4.241:8089/v1/models').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log).catch(()=>process.exit(1))"
curl --fail http://127.0.0.1:3000/api/analytics/llm-health
```

The health response must report `available` with model
`qwen3-coder-next`. Because llama.cpp is started manually, an `unavailable`
health response is expected while it is stopped; deterministic analytics and
saved-session viewing remain available.

The installed user unit is
`~/.config/systemd/user/llama-server.service`. After changing its bind address,
reload the unit and restart the manually managed process:

```bash
systemctl --user daemon-reload
systemctl --user restart llama-server
```

Do not run `systemctl --user enable llama-server` unless automatic startup is
later desired.

Keep this HTTP endpoint on the trusted private LAN with the source-restricted
firewall rule. Use TLS or a private tunnel if that trust boundary changes.

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
- Closing odds and betting results: `supabase/migrations/202609010001_closing_odds_results.sql`
- Saved analytics sessions: `supabase/migrations/202609010002_analysis_sessions.sql`

## App routes

- `/` dashboard with season, week, game, and live-game views
- `/games/:id` game detail and score breakdown
- `/games/:gameId/teams/:teamId` team box score and player statistics
- `/analytics` historical betting results and local-model analysis

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
