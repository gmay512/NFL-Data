import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GameRow, TeamRow } from '../types/nfl'

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
  const [game, setGame] = useState<GameRow | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const teamMap = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team])) as Record<number, TeamRow>, [teams])

  useEffect(() => {
    const loadGame = async () => {
      if (!supabase || !id) {
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      const gameId = Number(id)
      if (!Number.isFinite(gameId)) {
        setError('Invalid game id.')
        setIsLoading(false)
        return
      }

      const [gameResult, teamsResult] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameId).maybeSingle(),
        supabase.from('teams').select('id, name, logo_url').order('id', { ascending: true }),
      ])

      const firstError = [gameResult, teamsResult].find((result) => result.error)?.error
      if (firstError) {
        setError(firstError.message)
        setIsLoading(false)
        return
      }

      setGame((gameResult.data ?? null) as GameRow | null)
      setTeams((teamsResult.data ?? []) as TeamRow[])
      setIsLoading(false)
    }

    void loadGame()
  }, [id])

  const homeTeam = game?.home_team_id ? teamMap[game.home_team_id] : undefined
  const awayTeam = game?.away_team_id ? teamMap[game.away_team_id] : undefined
  const awayTeamHref = game?.away_team_id ? `/games/${game.id}/teams/${game.away_team_id}` : null
  const homeTeamHref = game?.home_team_id ? `/games/${game.id}/teams/${game.home_team_id}` : null

  return (
    <main>
      <section className="hero detail-hero">
        <p className="eyebrow">Game details</p>
        <h1>{game ? `${awayTeam?.name ?? 'Away'} at ${homeTeam?.name ?? 'Home'}` : 'Game details'}</h1>
        <p className="hero-copy">
          Basic game information for the selected matchup.
        </p>

        <div className="detail-actions">
          <Link className="week-nav-button detail-back-link" to="/games">
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
                <Link className="detail-team detail-team-link" to={awayTeamHref}>
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
                <Link className="detail-team detail-team-link" to={homeTeamHref}>
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