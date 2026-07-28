import { useEffect, useMemo, useState } from 'react'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type {
  GameEventRow,
  GamePlayerStatRow,
  GameRow,
  GameTeamStatRow,
  InjuryRow,
  LeagueRow,
  LeagueSeasonRow,
  PlayerRow,
  PlayerSeasonStatRow,
  StandingRow,
  TeamRow,
} from '../types/nfl'

type DashboardState = {
  leagues: LeagueRow[]
  leagueSeasons: LeagueSeasonRow[]
  teams: TeamRow[]
  players: PlayerRow[]
  games: GameRow[]
  gameEvents: GameEventRow[]
  injuries: InjuryRow[]
  playerSeasonStats: PlayerSeasonStatRow[]
  standings: StandingRow[]
  gameTeamStats: GameTeamStatRow[]
  gamePlayerStats: GamePlayerStatRow[]
}

const INITIAL_STATE: DashboardState = {
  leagues: [],
  leagueSeasons: [],
  teams: [],
  players: [],
  games: [],
  gameEvents: [],
  injuries: [],
  playerSeasonStats: [],
  standings: [],
  gameTeamStats: [],
  gamePlayerStats: [],
}

export function DashboardPage() {
  const [data, setData] = useState<DashboardState>(INITIAL_STATE)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadData = async () => {
      if (!supabase) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      const [
        leaguesResult,
        leagueSeasonsResult,
        teamsResult,
        playersResult,
        gamesResult,
        gameEventsResult,
        injuriesResult,
        playerSeasonStatsResult,
        standingsResult,
        gameTeamStatsResult,
        gamePlayerStatsResult,
      ] = await Promise.all([
        supabase.from('leagues').select('*').order('id', { ascending: true }).limit(15),
        supabase
          .from('league_seasons')
          .select('*')
          .order('id', { ascending: true })
          .limit(20),
        supabase.from('teams').select('*').order('id', { ascending: true }).limit(15),
        supabase.from('players').select('*').order('id', { ascending: true }).limit(15),
        supabase.from('games').select('*').order('id', { ascending: true }).limit(15),
        supabase
          .from('game_events')
          .select('*')
          .order('id', { ascending: true })
          .limit(20),
        supabase.from('injuries').select('*').order('id', { ascending: true }).limit(20),
        supabase
          .from('player_season_stats')
          .select('*')
          .order('id', { ascending: true })
          .limit(20),
        supabase.from('standings').select('*').order('id', { ascending: true }).limit(20),
        supabase
          .from('game_team_stats')
          .select('*')
          .order('id', { ascending: true })
          .limit(20),
        supabase
          .from('game_player_stats')
          .select('*')
          .order('id', { ascending: true })
          .limit(20),
      ])

      const firstError = [
        leaguesResult,
        leagueSeasonsResult,
        teamsResult,
        playersResult,
        gamesResult,
        gameEventsResult,
        injuriesResult,
        playerSeasonStatsResult,
        standingsResult,
        gameTeamStatsResult,
        gamePlayerStatsResult,
      ].find((result) => result.error)?.error

      if (firstError) {
        setError(firstError.message)
        setIsLoading(false)
        return
      }

      setData({
        leagues: (leaguesResult.data ?? []) as LeagueRow[],
        leagueSeasons: (leagueSeasonsResult.data ?? []) as LeagueSeasonRow[],
        teams: (teamsResult.data ?? []) as TeamRow[],
        players: (playersResult.data ?? []) as PlayerRow[],
        games: (gamesResult.data ?? []) as GameRow[],
        gameEvents: (gameEventsResult.data ?? []) as GameEventRow[],
        injuries: (injuriesResult.data ?? []) as InjuryRow[],
        playerSeasonStats: (playerSeasonStatsResult.data ?? []) as PlayerSeasonStatRow[],
        standings: (standingsResult.data ?? []) as StandingRow[],
        gameTeamStats: (gameTeamStatsResult.data ?? []) as GameTeamStatRow[],
        gamePlayerStats: (gamePlayerStatsResult.data ?? []) as GamePlayerStatRow[],
      })

      setIsLoading(false)
    }

    void loadData()
  }, [])

  const totalRows = useMemo(
    () =>
      data.leagues.length +
      data.leagueSeasons.length +
      data.teams.length +
      data.players.length +
      data.games.length +
      data.gameEvents.length +
      data.injuries.length +
      data.playerSeasonStats.length +
      data.standings.length +
      data.gameTeamStats.length +
      data.gamePlayerStats.length,
    [data],
  )

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">Schema dashboard</p>
        <h1>Supabase table snapshots</h1>
        <p className="hero-copy">
          Quick visibility into the full 11-table NFL schema built from API-Sports
          documentation. This page reads with anon access under RLS policies.
        </p>

        <div className="stats-grid">
          <article className="stat-card">
            <p className="stat-label">Tables queried</p>
            <p className="stat-value">11</p>
            <p className="stat-detail">Core + extended NFL schema tables.</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Rows loaded</p>
            <p className="stat-value">{totalRows}</p>
            <p className="stat-detail">Limited sample for fast page loads.</p>
          </article>
          <article className="stat-card">
            <p className="stat-label">Status</p>
            <p className="stat-value">{isLoading ? 'Loading' : 'Ready'}</p>
            <p className="stat-detail">
              {hasSupabaseEnv
                ? 'Connected with VITE_SUPABASE_URL + ANON key.'
                : 'Set local env values to connect this page.'}
            </p>
          </article>
        </div>
      </section>

      {!hasSupabaseEnv && (
        <section className="panel panel-wide status-banner">
          <h2>Missing environment values</h2>
          <p>
            Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your local env file,
            then restart the dev server.
          </p>
        </section>
      )}

      {error && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Query error</h2>
          <p>{error}</p>
        </section>
      )}

      <section className="panel panel-wide dashboard-nav" aria-label="Dashboard links">
        <a href="#leagues">Leagues</a>
        <a href="#league-seasons">League seasons</a>
        <a href="#teams">Teams</a>
        <a href="#players">Players</a>
        <a href="#games">Games</a>
        <a href="#game-events">Game events</a>
        <a href="#injuries">Injuries</a>
        <a href="#player-season-stats">Player season stats</a>
        <a href="#standings">Standings</a>
        <a href="#game-team-stats">Game team stats</a>
        <a href="#game-player-stats">Game player stats</a>
      </section>

      <section className="dashboard-grid">
        <article className="panel panel-wide table-panel" id="leagues">
          <div className="table-head">
            <h2>Leagues</h2>
            <span>{data.leagues.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'name', 'country_name', 'country_code']}
            rows={data.leagues.map((row) => [
              String(row.id),
              row.name,
              row.country_name ?? 'NULL',
              row.country_code ?? 'NULL',
            ])}
            emptyLabel="No league rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="league-seasons">
          <div className="table-head">
            <h2>League seasons</h2>
            <span>{data.leagueSeasons.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'league_id', 'season_year', 'is_current', 'cov_standings']}
            rows={data.leagueSeasons.map((row) => [
              String(row.id),
              String(row.league_id),
              String(row.season_year),
              String(row.is_current),
              String(row.cov_standings),
            ])}
            emptyLabel="No league season rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="teams">
          <div className="table-head">
            <h2>Teams</h2>
            <span>{data.teams.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'name', 'logo_url']}
            rows={data.teams.map((row) => [String(row.id), row.name, row.logo_url ?? 'NULL'])}
            emptyLabel="No team rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="players">
          <div className="table-head">
            <h2>Players</h2>
            <span>{data.players.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'name', 'image_url']}
            rows={data.players.map((row) => [String(row.id), row.name, row.image_url ?? 'NULL'])}
            emptyLabel="No player rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="games">
          <div className="table-head">
            <h2>Games</h2>
            <span>{data.games.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'season', 'week', 'home_team_id', 'away_team_id']}
            rows={data.games.map((row) => [
              String(row.id),
              row.season == null ? 'NULL' : String(row.season),
              row.week ?? 'NULL',
              row.home_team_id == null ? 'NULL' : String(row.home_team_id),
              row.away_team_id == null ? 'NULL' : String(row.away_team_id),
            ])}
            emptyLabel="No game rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="game-events">
          <div className="table-head">
            <h2>Game events</h2>
            <span>{data.gameEvents.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'game_id', 'team_id', 'player_id', 'quarter', 'event_type', 'score']}
            rows={data.gameEvents.map((row) => [
              String(row.id),
              String(row.game_id),
              String(row.team_id),
              row.player_id == null ? 'NULL' : String(row.player_id),
              row.quarter,
              row.event_type,
              `${row.score_home ?? '-'}:${row.score_away ?? '-'}`,
            ])}
            emptyLabel="No game event rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="injuries">
          <div className="table-head">
            <h2>Injuries</h2>
            <span>{data.injuries.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'player_id', 'team_id', 'injury_date', 'status']}
            rows={data.injuries.map((row) => [
              String(row.id),
              String(row.player_id),
              row.team_id == null ? 'NULL' : String(row.team_id),
              row.injury_date ?? 'NULL',
              row.status ?? 'NULL',
            ])}
            emptyLabel="No injury rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="player-season-stats">
          <div className="table-head">
            <h2>Player season stats</h2>
            <span>{data.playerSeasonStats.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'player_id', 'team_id', 'season', 'group', 'stat', 'value']}
            rows={data.playerSeasonStats.map((row) => [
              String(row.id),
              String(row.player_id),
              String(row.team_id),
              String(row.season),
              row.stat_group,
              row.stat_name,
              row.stat_value ?? 'NULL',
            ])}
            emptyLabel="No player season stat rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="standings">
          <div className="table-head">
            <h2>Standings</h2>
            <span>{data.standings.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'league_id', 'season', 'team_id', 'division', 'won', 'lost', 'ties']}
            rows={data.standings.map((row) => [
              String(row.id),
              String(row.league_id),
              String(row.season),
              String(row.team_id),
              row.division ?? 'NULL',
              String(row.won),
              String(row.lost),
              String(row.ties),
            ])}
            emptyLabel="No standings rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="game-team-stats">
          <div className="table-head">
            <h2>Game team stats</h2>
            <span>{data.gameTeamStats.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'game_id', 'team_id', 'yards_total', 'turnovers_total', 'possession']}
            rows={data.gameTeamStats.map((row) => [
              String(row.id),
              String(row.game_id),
              String(row.team_id),
              row.yards_total == null ? 'NULL' : String(row.yards_total),
              row.turnovers_total == null ? 'NULL' : String(row.turnovers_total),
              row.possession ?? 'NULL',
            ])}
            emptyLabel="No game team stat rows found yet."
            isLoading={isLoading}
          />
        </article>

        <article className="panel panel-wide table-panel" id="game-player-stats">
          <div className="table-head">
            <h2>Game player stats</h2>
            <span>{data.gamePlayerStats.length} rows</span>
          </div>
          <DataTable
            headers={['id', 'game_id', 'team_id', 'player_id', 'group', 'stat', 'value']}
            rows={data.gamePlayerStats.map((row) => [
              String(row.id),
              String(row.game_id),
              String(row.team_id),
              String(row.player_id),
              row.stat_group,
              row.stat_name,
              row.stat_value ?? 'NULL',
            ])}
            emptyLabel="No game player stat rows found yet."
            isLoading={isLoading}
          />
        </article>
      </section>
    </main>
  )
}

type DataTableProps = {
  headers: string[]
  rows: string[][]
  emptyLabel: string
  isLoading: boolean
}

function DataTable({ headers, rows, emptyLabel, isLoading }: DataTableProps) {
  if (isLoading) {
    return <p className="table-status">Loading rows...</p>
  }

  if (!rows.length) {
    return <p className="table-status">{emptyLabel}</p>
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${idx}-${row[0]}`}>
              {row.map((cell, cellIdx) => (
                <td key={`${idx}-${cellIdx}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
