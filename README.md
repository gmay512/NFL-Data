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

If `--season` is omitted, the script uses `API_SPORTS_SEASON` from `.env.local`
when set, otherwise the current NFL season.

The dashboard is the main ingest flow. Stored schedules appear without waiting
for provider season discovery, odds, or team statistics. Odds load and refresh
only for displayed games, and statistics load independently in the team view.
Secondary failures remain visible without hiding the schedule.

The default is the current NFL season (2026 initially), not the oldest stored
season or a hard-coded historical year. Current provider metadata takes
precedence in the UI; the date fallback retains the previous season through
February and advances in March. CLI ingest/backfill use the same date fallback.
An explicit `--season` or `API_SPORTS_SEASON` still overrides the ingest default.

Available seasons are discovered in the background from `/seasons`; when the
selected season has no local games, the dashboard offers a button that POSTs
the season to the app server. Older seasons remain available for explicit
imports. Normal metadata refreshes retain 2026 onward; explicit historical
imports also retain metadata for their requested season/range.

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
history. For Asian Handicap pairs, API-Sports repeats the home-team handicap
suffix on both the `Home` and `Away` outcomes; the application stores that
suffix as `home_spread`, where a negative value means the home team is favored.
The `game_consensus_odds` view selects each bookmaker's latest, most-balanced
full-game spread and total, then exposes their medians to the schedule and
game-detail UI without bookmaker identities or decimal prices.

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
bounded JSON fact catalog. Most reports select supported observations, which the
application validates and renders. Pregame reports also include model-written
narratives with explicit statement-level checks and warnings. It does not receive database credentials,
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

### Factual reports and evidence scope

Regular-season matchup previews default to completed regular-season games in the
selected season, involving the target teams, strictly before kickoff. Preseason
games are not included merely because closing odds or box scores exist.
Explicit stage filters remain available; postseason previews retain
regular/postseason history with preseason excluded. Historical presets keep
their requested filters. **Grounding details** on both dashboard previews and
saved conversations show the requested filters and effective history scope.

Selected-game home-cover and over rates describe that selection, not necessarily
the league, a particular team, or a comparable-matchup cohort. Team ATS records
and home/away splits are calculated from the team's perspective. Pushes and
ungraded games are separate from decisions. Each team-stat metric has its own
valid observation count, sum, and source game IDs; null statistics are never
filled with zeros. A truncated detail list does not shrink a full-sample
aggregate, and its game IDs are not represented as complete aggregate evidence.

Turnovers are turnovers committed, not turnover differential. The generic
provider `sacks` metric is not labeled sacks allowed. Offensive sacks allowed
are parsed only from the separate passing sacks/yardage field's `count-yards`
format; missing or unrecognized values are unavailable, with malformed formats
reported as data-quality warnings.

Injury reports preserve supplied status and position. Questionable does not
mean confirmed out. Injury dates, first/last observation dates, and report
generation time are distinct; none confirms final game-day availability.
Target odds are **stored current consensus**, distinct from historical closing
lines. Reading them for a new report does not establish provider freshness or
opening-line movement. Standings and player season totals are stored current
records, not reconstructed historical observations.

Other Analytics presets and focused conversational follow-ups require structured model output
containing only fact references and supported comparison templates. The server
also supplies a strict JSON response schema with catalog-ID enums, exact fields,
and a 1-40 observation limit to llama.cpp so generation follows the same shape
as validation. Semantic comparison and duplicate checks still run in the app.
The model-facing catalog omits redundant metadata and is bounded to 600 facts
and 60,000 serialized fact characters, prioritizing sample/ATS/totals facts and
turnover/sacks-allowed coverage across teams before optional detail. Omitted
facts are disclosed and cannot be selected, including in follow-ups; full
metrics remain in the immutable snapshot, and grounding details show coverage.
This avoids filling the model context with repeated prose on league-wide selections.
The server rejects extra fields, invented references, duplicate observations, incompatible
comparisons, free-form factual prose, and unfinished completions before saving.
Unsupported questions can cite explicit missing-data limitations instead.
Follow-up SSE connections retain heartbeats and cancellation, but raw model
tokens are buffered: only validated, application-rendered content is displayed
after successful persistence. Validation failures show an error and do not
create a successful exchange.

Validated selections are formatted into Markdown by the application, with
section headings, observation lists, emphasized evidence labels, and tables
for compatible numeric comparisons. The model still selects only fact
references; it does not author factual prose or formatting. Dashboard game
analyses and Analytics assistant messages/follow-ups use the same Markdown
renderer, including scrollable tables on narrow screens. User messages stay
plain text. Raw HTML and unsafe links are disabled, and embedded images are
shown as text rather than loaded from external sources.

Existing saved Markdown is rendered without rewriting messages or snapshots.
Previously saved plain-text reports remain readable; their content is not
reconstructed or upgraded to a newly validated report by the display layer.

### Pregame matchup reports and printing

New pregame matchup reports follow a fixed layout: a matchup summary,
prior-performance tables, current injuries, and these five numbered observations:
Home Spread Performance; Totals Performance; Offensive Efficiency & Turnovers;
Missing/Ungraded Data; and Odds Context. Every section includes an interpretation
and summary, followed by overall observations and a summary of uncertainty.
The application renders the tables directly from the saved source snapshot,
including away/home splits, metric-specific samples, missing values, and
source-scope disclosures. Completed-game reviews and weekly suggestions keep
their existing formats.

The local model writes short, structured interpretations and summaries citing
catalog facts. Application checks flag unknown or out-of-section references,
unsupported numeric values and identities, and permit calculated differences
only for compatible finite metrics. A separate, batched local-model pass
checks each entire statement against its cited evidence, including units,
denominators, time/location/stage scope, and injury/market terminology.
**Model verification is an additional check, not a guarantee of correctness.**

Unsupported statements and statements that cannot be verified remain in the
report with explicit labels, source references, and reasons. They do not
prevent saving an otherwise well-formed analysis and are not endorsed as
source facts. A failed or incomplete verification pass is disclosed as
unverified rather than silently accepted. Malformed or unfinished narrative
generation, cancellation, source-read failures, and save failures still report
errors. Both model passes use the configured local service and its existing
request/context/output limits; generation and verification usage are combined
when available.

**Print analysis** in the dashboard preview or beside a saved matchup reply
opens the browser print dialog for that selected report only. It prints
rendered Markdown headings, tables, interpretations, summaries, evidence,
and verification warnings, without navigation, controls, other messages, or
raw grounding JSON. The browser's Save as PDF option can also be used.
Printing is independent of the page's light/dark theme and does not change the
existing Weekly Analysis print action.

Saved messages and their snapshots are not rewritten. Generate a new preview
to obtain the new layout; existing reports can still print their original
rendered content. Conversational follow-ups stay focused, use the immutable
saved snapshot and the stricter fact-selection contract, and never treat prior
model narratives or flagged statements as verified source evidence.

New snapshots use analytics schema version 2. Existing version-1 snapshots and
messages remain unchanged and readable, with a legacy warning. Follow-ups can
use their supplied facts but cannot infer missing scope, per-field denominators,
injury observations, or freshness from prior prose. Regenerate an analysis when
those facts are needed; follow-ups never silently refresh an immutable snapshot.
No database reset or external fact-checking service is required.

### Upcoming-week suggestions and tracking

The Weekly Analysis page can manually analyze the nearest future scheduled week
for the selected season. Regular-season and postseason games are eligible;
preseason games are excluded from both target weeks and historical evidence.
Regular-season targets use the same regular-season-only preview history policy.
It builds a bounded snapshot for every matchup using the current consensus
spread and total, team-perspective scoring, season-to-date ATS and totals
results, available team and player statistics, standings, and current injuries.
The local model returns only structured pick selections, confidence, and cited
game IDs. The server validates those fields and generates the displayed summary
and rationale from recorded scores and trend facts, preventing model-written
score attribution. Each pick must cite one to three games from that target
matchup's supplied history, not the upcoming game or another matchup's history.
Picks with missing or out-of-history citations are omitted in full; the app
does not substitute evidence or keep only the valid portion of a citation list.
Picks without prior history or an available consensus line are also omitted.
The saved summary reports omission counts, reasons, and original pick numbers,
while valid picks retain their original order. If none remain, a zero-pick run
is saved with those warnings and contributes nothing to the tracked record.
Malformed output, unknown target games, invalid fields or supporting-ID formats,
duplicate game-market picks (including omitted picks), and model-supplied line
fields still reject the entire run.

Every valid suggestion is automatically saved in `betting_analysis_runs` and
`betting_suggestions`. These tables are separate from the source game schema and
snapshot the matchup, kickoff, rationale, confidence, and consensus line. A
later analysis of the same week creates a new timestamped run rather than
replacing earlier predictions. A model decision to make no pick remains in the
run summary and does not count toward the tracked record.

Use **Grade completed picks** after games finish. Spread and total picks are
graded against the consensus line locked when the suggestion was generated,
not the later closing line. Completed `FT` and `AOT` scores produce a win, loss,
or push; unfinished or missing-score games remain pending. Grading is
idempotent and never changes the stored recommendation or locked line. Before
grading, the server refreshes only the distinct games referenced by pending
picks whose kickoff has passed, then reports how many games were checked and
how many suggestions were graded.

### Availability and failure behavior

The historical tables and filters continue to work when llama.cpp is stopped,
unreachable, timed out, or serving a different model. The page reports the local
model as offline and disables new model requests; existing saved analyses remain
readable. A failed or cancelled completion is not stored as a successful
exchange. Start llama.cpp with the configured model and retry when health is
available.

All browser requests go to this app's `/api/analytics` routes. The browser never
connects directly to llama.cpp.

### Analytics loading and freshness

Historical navigation uses `POST /api/analytics/overview` for the visible
results, trends, and line-quality counts, without loading model supporting
data. `POST /api/analytics/query` remains the full-grounding contract. New model
analyses always read fresh source data; saved conversations retain their
immutable grounding snapshots.

Weekly navigation uses `GET /api/analytics/weekly/summaries` and fetches only
the selected run through `GET /api/analytics/weekly/runs/:id`. Lists omit
grounding and loss evidence; selected details include the loss metrics used by
the display, not the original evidence snapshot. Records and week options
cover the complete selected season, independently of the displayed page.
Saved lists use stable 25-item cursor pages with **Load older analyses**
controls. Conversations initially show the newest 50 messages and can load
older messages; model follow-ups use only the configured recent history.

The browser shares in-flight reads and keeps exact-filter results in a bounded
in-memory cache: 60 seconds for data, five minutes for metadata, and five
seconds for model health. Same-filter revisits show cached content while
refreshing; different filters never borrow another filter's results. Mutations
invalidate related reads. Expired same-filter content is explicitly marked as
refreshing rather than silently presented as current. Both tabs reserve compact
refresh indicators and model-status/help space so routine background checks do
not shift the displayed content; expired model health still cannot keep
generation enabled. Known saved output remains visible if its
background refresh fails, with an explicit error and retry control. Ordinary reads have
a 15-second deadline and health checks at most five seconds; generation and
ingestion retain their separate budgets. Obsolete reads and disconnected model
requests are cancelled. Incomplete streams are not reported as saved, and
mutations/model generation are never automatically retried.

Apply `202610030002_optimize_analytics_loading.sql` **before deploying the
updated application**. It preserves closing-result semantics while calculating
consensus once per bounded batch, and adds the service-role-only weekly-summary
RPC. No timeout increase, database reset, or history pruning is required.
Rollout is a separate operation; editing this repository does not deploy it.

Read-only diagnostics against the sampled 2026 production history measured the
closing-results SQL body at approximately **76 ms for the previously failing
ten-game batch**, versus **8.85 seconds** for the original query. All 98
completed games took **816 ms** in one SQL-body diagnostic. The two-run summary
projection measured **732 bytes**, versus **162,820 bytes** for the previous
full-run list. Adding the sampled selected-detail projection (about 6 KB) still
reduces that initial transfer by approximately **96%**. The real overview
handler and data-source pipeline, using a read-only SQL adapter against
production instead of installing the RPC, completed the 98-game selection in
**2.53 seconds** initially and **2.00 seconds** on repeat; two concurrent
requests each took about **2.08 seconds**, and a seven-game team selection took
**551 ms**. These include diagnostic SSH overhead but are not deployed
end-to-end page benchmarks. Confirm browser cold/warm page timings after the
separately authorized rollout.
Analytics read logs include request IDs, durations, row counts, payload bytes,
and structured failure codes, without recording model context or messages.

The production topology uses:

- application host: `192.168.4.237`;
- llama.cpp host: `192.168.4.46`;
- private model endpoint: `http://192.168.4.46:8089`.

Reserve `192.168.4.46` for the LLM workstation's network interface in the
router/DHCP server, or use a stable LAN hostname. The current address works, but
this application configuration does not create a DHCP reservation. If the
address changes, update `LLM_BASE_URL` and redeploy; a running model on a new
address cannot be reached through an old configured endpoint.

On `192.168.4.46`, llama.cpp needs one IPv4 listener for both loopback and LAN
requests. An equivalent manual launch is:

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
`http://192.168.4.46:8089`. Because it listens on every IPv4 interface, keep
UFW enabled and permit only the application host:

```bash
sudo ufw allow proto tcp \
  from 192.168.4.237 \
  to 192.168.4.46 port 8089 \
  comment 'NFL analytics llama.cpp'
sudo ufw status numbered
```

The production app uses host networking and can route directly to the private
LAN address, so Docker Compose does not need another network and nginx must not
proxy port 8089. CORS configuration is also unnecessary because the Node server,
not the browser, is the LLM client.

Set the endpoint in `.env.local` before deploying:

```text
LLM_BASE_URL=http://192.168.4.46:8089
LLM_MODEL=qwen3-coder-next
```

`scripts/deploy.sh` copies `LLM_*` values from `.env.local` into the protected
production environment. Shell variables passed to the deploy command take
precedence, and the deployment-specific fallback is the remote endpoint above.

After starting llama.cpp, verify the route from the application host and from
inside the app container:

```bash
curl --fail http://192.168.4.46:8089/v1/models
docker exec nfl-data-app node -e \
  "fetch('http://192.168.4.46:8089/v1/models').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log).catch(()=>process.exit(1))"
curl --fail http://127.0.0.1:3000/api/analytics/llm-health
```

The health response must report `available` with model
`qwen3-coder-next`. An `unavailable` health response is expected while the
service is stopped or unreachable; deterministic analytics and saved-session
viewing remain available.

The installed user unit is
`~/.config/systemd/user/llama-server.service`. Start and inspect it manually
without launching a second server on the same port:

```bash
systemctl --user start llama-server
systemctl --user status llama-server
```

The service remains running until explicitly stopped with
`systemctl --user stop llama-server` or the user service manager shuts down.
After changing the unit's bind address, reload the unit and restart it:

```bash
systemctl --user daemon-reload
systemctl --user restart llama-server
```

Do not run `systemctl --user enable llama-server` unless automatic startup is
later desired.

Keep this HTTP endpoint on the trusted private LAN with the source-restricted
firewall rule. Use TLS or a private tunnel if that trust boundary changes.

The production-only backfill runner defaults to the current NFL season, records
complete and provider-empty checkpoints, preserves season team membership in
`team_rosters`, and stops before the configured API daily ceiling:

```bash
npm run backfill -- --dry-run
npm run backfill -- --confirm-production
```

Use explicit `--start-season` and `--end-season` values to import a historical
range; `--daily-ceiling` and `--verbose-plan` customize its budget and output.
The runtime refuses mutating runs against the known local Supabase address.

## One-time historical cleanup

Cleanup is separate from schema migrations and never runs automatically.
It keeps the specified NFL season and all later seasons, while deleting older
games, dependent odds/events/box scores, season statistics, standings, rosters,
metadata, and backfill checkpoints. Saved analyses and weekly runs containing
older grounding are deleted with their messages, suggestions, and loss
explanations. Shared reference tables and active injuries are preserved.

Dry-run both targets first:

```bash
npm run prune -- --target=local --keep-from=2026
npm run prune -- --target=production --keep-from=2026
```

Explicitly confirm each destructive operation:

```bash
npm run prune -- --target=local --keep-from=2026 --confirm=local-before-2026
npm run prune -- --target=production --keep-from=2026 --confirm=production-before-2026
```

The local container defaults to `supabase_db_NFL_Data`; production defaults to
`glenn@192.168.4.237` / `supabase-db`. Override `LOCAL_DB_CONTAINER`,
`DEPLOY_HOST`, or `REMOTE_DB_CONTAINER` when needed. Restore the local stack
with `npm run db:start` first; **do not reset it** just to run cleanup.

Game deletion uses the recorded NFL season, so January playoff games from an
older season are also removed. Injuries have no season field: resolved episodes
dated before March 1 of the retained year are considered historical, matching
the date-based season rollover. Active injuries are kept regardless of date.
Undated resolved episodes are reported and block deletion until reviewed.

Execution locks the affected NFL tables against concurrent writes, deletes in
foreign-key-safe order, and verifies historical absence plus counts and
fingerprints of every retained table's rows before committing. Any failure
rolls back the entire operation. A rerun is safe, but will delete older data
that was explicitly reimported in the meantime. There is no ongoing retention
job: historical imports remain allowed and persist after this one-time cleanup.

Run isolated cleanup regression fixtures against a temporary database in the
local NFL Supabase container:

```bash
NFL_CLEANUP_TEST=1 node --import tsx --test test/prune-season-data.test.ts
```

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
