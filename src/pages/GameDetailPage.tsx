import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GameRow, GameTeamStatRow, TeamRow } from '../types/nfl'

function formatGameStatus(game: GameRow | null) {
  if (!game) return 'Loading'
  if (game.status_short === 'FT') return 'Final'
  if (game.status_short === 'NS') return 'Scheduled'
  if (game.status_short === 'PST') return 'Postponed'
  if (game.status_short === 'CANC') return 'Cancelled'
  if (game.status_short && game.status_timer) return `${game.status_short} ${game.status_timer}`

  return game.status_long || game.status_short || 'Unknown status'
}

function renderValue(value: string | number | null | undefined) {
  if (value == null || value === '') return '—'
  return String(value)
}

function renderQuarterValue(value: number | null | undefined) {
  return value == null ? '—' : String(value)
}

export function GameDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const [game, setGame] = useState<GameRow | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamStats, setTeamStats] = useState<GameTeamStatRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingStats, setIsLoadingStats] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)

  const teamMap = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team])) as Record<number, TeamRow>, [teams])

  useEffect(() => {
    const loadGame = async () => {
      if (!supabase || !id) {
        setIsLoading(false)
        setIsLoadingStats(false)
        return
      }

      setIsLoading(true)
      setIsLoadingStats(true)
      setError(null)
      setStatsError(null)
      setTeamStats([])

      const gameId = Number(id)
      if (!Number.isFinite(gameId)) {
        setError('Invalid game id.')
        setIsLoading(false)
        setIsLoadingStats(false)
        return
      }

      const [gameResult, teamsResult, teamStatsResult] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
        supabase.from('teams').select('id, name, logo_url').order('id', { ascending: true }),
        supabase.from('game_team_stats').select('*').eq('game_id', gameId),
      ])

      const firstError = [gameResult, teamsResult, teamStatsResult].find((result) => result.error)?.error
      if (firstError) {
        setError(firstError.message)
        setIsLoading(false)
        setIsLoadingStats(false)
        return
      }

      let loadedGame = (gameResult.data ?? null) as GameRow | null
      let loadedTeams = (teamsResult.data ?? []) as TeamRow[]
      let storedStats = (teamStatsResult.data ?? []) as GameTeamStatRow[]

      if (!loadedGame) {
        try {
          const response = await fetch('/api/refresh-game', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId }),
          })
          const payload = (await response.json()) as { error?: string }
          if (!response.ok) {
            throw new Error(payload.error ?? 'Could not load this game.')
          }

          const [persistedGameResult, persistedTeamsResult, persistedStatsResult] = await Promise.all([
            supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
            supabase.from('teams').select('id, name, logo_url').order('id', { ascending: true }),
            supabase.from('game_team_stats').select('*').eq('game_id', gameId),
          ])
          const persistedError = [persistedGameResult, persistedTeamsResult, persistedStatsResult].find((result) => result.error)?.error
          if (persistedError) throw persistedError

          loadedGame = (persistedGameResult.data ?? null) as GameRow | null
          loadedTeams = (persistedTeamsResult.data ?? []) as TeamRow[]
          storedStats = (persistedStatsResult.data ?? []) as GameTeamStatRow[]
        } catch (gameLoadError) {
          setError(gameLoadError instanceof Error ? gameLoadError.message : 'Could not load this game.')
          setIsLoading(false)
          setIsLoadingStats(false)
          return
        }
      }

      setGame(loadedGame)
      setTeams(loadedTeams)
      setTeamStats(storedStats)

      if (storedStats.length > 0 || !loadedGame) {
        setIsLoadingStats(false)
        setIsLoading(false)
        return
      }

      setIsLoading(false)
      try {
        const response = await fetch('/api/refresh-game-team-stats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gameId }),
        })
        const payload = (await response.json()) as { rows?: GameTeamStatRow[]; error?: string }
        if (!response.ok) {
          throw new Error(payload.error ?? 'Could not load game stats.')
        }

        setTeamStats(payload.rows ?? [])
      } catch (statsLoadError) {
        setStatsError(statsLoadError instanceof Error ? statsLoadError.message : 'Could not load game stats.')
      } finally {
        setIsLoadingStats(false)
      }
    }

    void loadGame()
  }, [id])

  const homeTeam = game?.home_team_id ? teamMap[game.home_team_id] : undefined
  const awayTeam = game?.away_team_id ? teamMap[game.away_team_id] : undefined
  const awayTeamStats = game?.away_team_id ? teamStats.find((stats) => stats.team_id === game.away_team_id) : undefined
  const homeTeamStats = game?.home_team_id ? teamStats.find((stats) => stats.team_id === game.home_team_id) : undefined
  const awayTeamHref = game?.away_team_id ? `/games/${game.id}/teams/${game.away_team_id}` : null
  const homeTeamHref = game?.home_team_id ? `/games/${game.id}/teams/${game.home_team_id}` : null
  const dashboardPath = (location.state as { dashboardPath?: string } | null)?.dashboardPath ?? '/games'

  return (
    <main>
      <section className="hero detail-hero">
        <p className="eyebrow">Game details</p>
        <h1>{game ? `${awayTeam?.name ?? 'Away'} at ${homeTeam?.name ?? 'Home'}` : 'Game details'}</h1>
        <p className="hero-copy">
          Basic game information for the selected matchup.
        </p>

        <div className="detail-actions">
          <Link className="week-nav-button detail-back-link" to={dashboardPath}>
            Back to games
          </Link>
          {game && <span className="detail-status-pill">{formatGameStatus(game)}</span>}
        </div>
      </section>

      {!hasSupabaseEnv && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Missing environment values</h2>
          <p>Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect this page.</p>
        </section>
      )}

      {error && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Game load error</h2>
          <p>{error}</p>
        </section>
      )}

      <section className="panel panel-wide detail-panel">
        {isLoading ? (
          <p className="table-status">Loading game details...</p>
        ) : !game ? (
          <p className="table-status">No game found for that id.</p>
        ) : (
          <>
            <div className="detail-scoreboard">
              {awayTeamHref ? (
                <Link className="detail-team detail-team-link" to={awayTeamHref} state={{ dashboardPath }}>
                  <div className="team-mark detail-team-mark">
                    {awayTeam?.logo_url ? <img src={awayTeam.logo_url} alt="" /> : <span>A</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Away team</p>
                    <h2>{awayTeam?.name ?? `Team ${game.away_team_id ?? ''}`}</h2>
                  </div>
                  <strong className="detail-team-score">{renderValue(game.away_total)}</strong>
                </Link>
              ) : (
                <div className="detail-team">
                  <div className="team-mark detail-team-mark">
                    {awayTeam?.logo_url ? <img src={awayTeam.logo_url} alt="" /> : <span>A</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Away team</p>
                    <h2>{awayTeam?.name ?? `Team ${game.away_team_id ?? ''}`}</h2>
                  </div>
                  <strong className="detail-team-score">{renderValue(game.away_total)}</strong>
                </div>
              )}

              <div className="detail-score-divider" />

              {homeTeamHref ? (
                <Link className="detail-team detail-team-link" to={homeTeamHref} state={{ dashboardPath }}>
                  <div className="team-mark detail-team-mark">
                    {homeTeam?.logo_url ? <img src={homeTeam.logo_url} alt="" /> : <span>H</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Home team</p>
                    <h2>{homeTeam?.name ?? `Team ${game.home_team_id ?? ''}`}</h2>
                  </div>
                  <strong className="detail-team-score">{renderValue(game.home_total)}</strong>
                </Link>
              ) : (
                <div className="detail-team">
                  <div className="team-mark detail-team-mark">
                    {homeTeam?.logo_url ? <img src={homeTeam.logo_url} alt="" /> : <span>H</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Home team</p>
                    <h2>{homeTeam?.name ?? `Team ${game.home_team_id ?? ''}`}</h2>
                  </div>
                  <strong className="detail-team-score">{renderValue(game.home_total)}</strong>
                </div>
              )}
            </div>

            <section className="detail-boxscore" aria-label="Quarter box score">
              <div className="section-heading detail-section-heading">
                <p className="eyebrow">Box score</p>
                <h2>Quarter-by-quarter scoring</h2>
              </div>

              <div className="boxscore-table-wrap">
                <table className="boxscore-table">
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>Q1</th>
                      <th>Q2</th>
                      <th>Q3</th>
                      <th>Q4</th>
                      <th>OT</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">{awayTeam?.name ?? 'Away team'}</th>
                      <td>{renderQuarterValue(game.away_q1)}</td>
                      <td>{renderQuarterValue(game.away_q2)}</td>
                      <td>{renderQuarterValue(game.away_q3)}</td>
                      <td>{renderQuarterValue(game.away_q4)}</td>
                      <td>{renderQuarterValue(game.away_ot)}</td>
                      <td>{renderQuarterValue(game.away_total)}</td>
                    </tr>
                    <tr>
                      <th scope="row">{homeTeam?.name ?? 'Home team'}</th>
                      <td>{renderQuarterValue(game.home_q1)}</td>
                      <td>{renderQuarterValue(game.home_q2)}</td>
                      <td>{renderQuarterValue(game.home_q3)}</td>
                      <td>{renderQuarterValue(game.home_q4)}</td>
                      <td>{renderQuarterValue(game.home_ot)}</td>
                      <td>{renderQuarterValue(game.home_total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section className="detail-game-stats" aria-label="Game team statistics">
              <div className="section-heading detail-section-heading">
                <p className="eyebrow">Game stats</p>
                <h2>Team comparison</h2>
              </div>

              {isLoadingStats ? (
                <p className="stats-loading-message">Loading game stats from API-Sports…</p>
              ) : statsError ? (
                <p className="stats-loading-message is-error">{statsError}</p>
              ) : !awayTeamStats && !homeTeamStats ? (
                <p className="stats-loading-message">Game statistics are not available yet.</p>
              ) : (
                <GameStatsTable awayTeam={awayTeam?.name ?? 'Away team'} homeTeam={homeTeam?.name ?? 'Home team'} awayStats={awayTeamStats} homeStats={homeTeamStats} />
              )}
            </section>

            <div className="detail-grid">
              <article className="stat-card detail-stat">
                <p className="stat-label">Season</p>
                <p className="stat-value">{renderValue(game.season)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Week</p>
                <p className="stat-value">{renderValue(game.week)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Date</p>
                <p className="stat-value">{renderValue(game.game_date)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Time</p>
                <p className="stat-value">{renderValue(game.game_time)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Status</p>
                <p className="stat-value">{formatGameStatus(game)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Venue</p>
                <p className="stat-value">
                  {[game.venue_name, game.venue_city].filter(Boolean).join(', ') || '—'}
                </p>
              </article>
            </div>

          </>
        )}
      </section>
    </main>
  )
}

function GameStatsTable({
  awayTeam,
  homeTeam,
  awayStats,
  homeStats,
}: {
  awayTeam: string
  homeTeam: string
  awayStats?: GameTeamStatRow
  homeStats?: GameTeamStatRow
}) {
  const rows: Array<[string, string | number | null | undefined, string | number | null | undefined]> = [
    ['Total yards', awayStats?.yards_total, homeStats?.yards_total],
    ['Passing yards', awayStats?.pass_yards, homeStats?.pass_yards],
    ['Rushing yards', awayStats?.rush_yards, homeStats?.rush_yards],
    ['Total plays', awayStats?.plays_total, homeStats?.plays_total],
    ['First downs', awayStats?.fd_total, homeStats?.fd_total],
    ['Third down efficiency', awayStats?.third_down_eff, homeStats?.third_down_eff],
    ['Possession', awayStats?.possession, homeStats?.possession],
    ['Turnovers', awayStats?.turnovers_total, homeStats?.turnovers_total],
  ]

  return (
    <div className="boxscore-table-wrap">
      <table className="boxscore-table game-stats-table">
        <colgroup>
          <col className="game-stats-team-column" />
          <col className="game-stats-label-column" />
          <col className="game-stats-team-column" />
        </colgroup>
        <thead>
          <tr>
            <th>{awayTeam}</th>
            <th>Stat</th>
            <th>{homeTeam}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, awayValue, homeValue]) => (
            <tr key={label}>
              <td>{renderValue(awayValue)}</td>
              <th scope="row">{label}</th>
              <td>{renderValue(homeValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}