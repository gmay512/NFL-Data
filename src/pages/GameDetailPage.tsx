import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { refreshGame, refreshGameStats, refreshGameTeamStats } from '../api/app-api'
import {
  getGameOverview,
  getGameOdds,
  getGamePlayerStats,
  getGameTeamStats,
  getPlayersByIds,
} from '../data/nfl-repository'
import {
  FullTeamStatsPanel,
  GameDetailTabButton,
  GameStatsTable,
  TeamStatSelector,
  type GameDetailTab,
} from '../features/game-detail/GameDetailComponents'
import { GameOddsDisplay } from '../features/odds/GameOddsDisplay'
import { useVisiblePolling } from '../hooks/useVisiblePolling'
import { formatDetailGameStatus, formatValue } from '../lib/game-format'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import { shouldRefreshGame } from '../lib/game-sync'
import type { GameOddsRow, GamePlayerStatRow, GameRow, GameTeamStatRow, PlayerRow, TeamRow } from '../types/nfl'

function renderQuarterValue(value: number | null | undefined) {
  return value == null ? '—' : String(value)
}

const ODDS_REFRESH_INTERVAL_MS = 5 * 60_000

export function GameDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const [game, setGame] = useState<GameRow | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamStats, setTeamStats] = useState<GameTeamStatRow[]>([])
  const [odds, setOdds] = useState<GameOddsRow | null>(null)
  const [activeTab, setActiveTab] = useState<GameDetailTab>('comparison')
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null)
  const [playerStats, setPlayerStats] = useState<GamePlayerStatRow[]>([])
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [showFullTeamStats, setShowFullTeamStats] = useState(false)
  const [isLoadingFullTeamStats, setIsLoadingFullTeamStats] = useState(false)
  const [fullTeamStatsError, setFullTeamStatsError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingStats, setIsLoadingStats] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [refreshStatsOnLoad, setRefreshStatsOnLoad] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)

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
      setOdds(null)

      const gameId = Number(id)
      if (!Number.isFinite(gameId)) {
        setError('Invalid game id.')
        setIsLoading(false)
        setIsLoadingStats(false)
        return
      }

      let overview
      try {
        overview = await getGameOverview(gameId)
      } catch (overviewError) {
        setError(overviewError instanceof Error ? overviewError.message : 'Could not load game details.')
        setIsLoading(false)
        setIsLoadingStats(false)
        return
      }

      let loadedGame = overview.game
      let loadedTeams = overview.teams
      let storedStats = overview.teamStats
      let storedOdds = overview.odds
      const refreshCurrentGame = loadedGame ? shouldRefreshGame(loadedGame) : true
      setRefreshStatsOnLoad(refreshCurrentGame)

      if (refreshCurrentGame) {
        try {
          await refreshGame(gameId)
          const persistedOverview = await getGameOverview(gameId)
          loadedGame = persistedOverview.game
          loadedTeams = persistedOverview.teams
          storedStats = persistedOverview.teamStats
          storedOdds = persistedOverview.odds
        } catch (gameLoadError) {
          const message = gameLoadError instanceof Error ? gameLoadError.message : 'Could not refresh this game.'
          if (!loadedGame) {
            setError(message)
            setIsLoading(false)
            setIsLoadingStats(false)
            return
          }
          setStatsError(message)
        }
      }

      setGame(loadedGame)
      setTeams(loadedTeams)
      setTeamStats(storedStats)
      setOdds(storedOdds)
      if (loadedGame) {
        setSelectedTeamId((currentTeamId) =>
          currentTeamId === loadedGame?.away_team_id || currentTeamId === loadedGame?.home_team_id
            ? currentTeamId
            : loadedGame?.away_team_id ?? loadedGame?.home_team_id ?? null,
        )
      }

      if ((!refreshCurrentGame && storedStats.length > 0) || !loadedGame) {
        if (loadedGame) setLastCheckedAt(new Date())
        setIsLoadingStats(false)
        setIsLoading(false)
        return
      }

      setIsLoading(false)
      try {
        await refreshGameTeamStats(gameId)
        setTeamStats(await getGameTeamStats(gameId))
        setLastCheckedAt(new Date())
      } catch (statsLoadError) {
        setStatsError(statsLoadError instanceof Error ? statsLoadError.message : 'Could not load game stats.')
      } finally {
        setIsLoadingStats(false)
      }
    }

    void loadGame()
  }, [id, refreshKey])

  const homeTeam = game?.home_team_id ? teamMap[game.home_team_id] : undefined
  const awayTeam = game?.away_team_id ? teamMap[game.away_team_id] : undefined
  const awayTeamStats = game?.away_team_id ? teamStats.find((stats) => stats.team_id === game.away_team_id) : undefined
  const homeTeamStats = game?.home_team_id ? teamStats.find((stats) => stats.team_id === game.home_team_id) : undefined
  const dashboardPath = (location.state as { dashboardPath?: string } | null)?.dashboardPath ?? '/games'

  useVisiblePolling(
    async () => setRefreshKey((current) => current + 1),
    Boolean(game && shouldRefreshGame(game)),
  )

  const refreshStoredOdds = useCallback(async () => {
    if (!game) return
    try {
      const oddsRows = await getGameOdds([game.id])
      setOdds(oddsRows[0] ?? null)
    } catch (oddsError) {
      setError(oddsError instanceof Error ? oddsError.message : 'Could not refresh game odds.')
    }
  }, [game])

  const isPregame = game?.status_short?.trim().toUpperCase() === 'NS'
  useVisiblePolling(refreshStoredOdds, isPregame, ODDS_REFRESH_INTERVAL_MS)

  const handleTeamSelect = (teamId: number) => {
    setSelectedTeamId(teamId)
    setShowFullTeamStats(false)
    setPlayerStats([])
    setPlayers([])
    setFullTeamStatsError(null)
  }

  const loadFullTeamStats = useCallback(async () => {
    if (!supabase || !game || !selectedTeamId) return

    setShowFullTeamStats(true)
    setIsLoadingFullTeamStats(true)
    setFullTeamStatsError(null)
    try {
      let storedPlayerStats = await getGamePlayerStats(game.id, selectedTeamId)

      if (refreshStatsOnLoad || (storedPlayerStats ?? []).length === 0) {
        await refreshGameStats(game.id, selectedTeamId, {
          loadTeamStats: false,
          loadPlayerStats: true,
        })
        storedPlayerStats = await getGamePlayerStats(game.id, selectedTeamId)
      }

      const loadedPlayerStats = storedPlayerStats
      const playerIds = Array.from(new Set(loadedPlayerStats.map((stat) => stat.player_id)))
      let loadedPlayers: PlayerRow[] = []
      if (playerIds.length > 0) {
        loadedPlayers = await getPlayersByIds(playerIds)
      }

      setPlayerStats(loadedPlayerStats)
      setPlayers(loadedPlayers)
    } catch (loadError) {
      setFullTeamStatsError(loadError instanceof Error ? loadError.message : 'Could not load player statistics.')
    } finally {
      setIsLoadingFullTeamStats(false)
    }
  }, [game, refreshStatsOnLoad, selectedTeamId])

  useEffect(() => {
    if (!game || !selectedTeamId) return
    const timeoutId = window.setTimeout(() => void loadFullTeamStats(), 0)
    return () => window.clearTimeout(timeoutId)
  }, [game, loadFullTeamStats, selectedTeamId])

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
          {game && <span className="detail-status-pill">{formatDetailGameStatus(game)}</span>}
          {lastCheckedAt && (
            <span className="detail-refresh-time">Last checked {lastCheckedAt.toLocaleTimeString()}</span>
          )}
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

      {!isLoading && game && (
        <section className="game-meta-card game-meta-panel">
          <dl>
            <div>
              <dt>Season</dt>
              <dd>{formatValue(game.season)}</dd>
            </div>
            <div>
              <dt>Week</dt>
              <dd>{formatValue(game.week)}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{formatValue(game.game_date)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{formatValue(game.game_time)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{formatDetailGameStatus(game)}</dd>
            </div>
            <div>
              <dt>Venue</dt>
              <dd>{[game.venue_name, game.venue_city].filter(Boolean).join(', ') || '—'}</dd>
            </div>
          </dl>
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
              <div className="detail-team">
                <div className="team-mark detail-team-mark">
                  {awayTeam?.logo_url ? <img src={awayTeam.logo_url} alt="" /> : <span>A</span>}
                </div>
                <div>
                  <p className="game-card-label">Away team</p>
                  <h2>{awayTeam?.name ?? `Team ${game.away_team_id ?? ''}`}</h2>
                </div>
                <strong className="detail-team-score">{formatValue(game.away_total)}</strong>
              </div>

              <div className="detail-score-divider" />

              <div className="detail-team">
                <div className="team-mark detail-team-mark">
                  {homeTeam?.logo_url ? <img src={homeTeam.logo_url} alt="" /> : <span>H</span>}
                </div>
                <div>
                  <p className="game-card-label">Home team</p>
                  <h2>{homeTeam?.name ?? `Team ${game.home_team_id ?? ''}`}</h2>
                </div>
                <strong className="detail-team-score">{formatValue(game.home_total)}</strong>
              </div>
            </div>

            <GameOddsDisplay
              odds={odds}
              awayTeamName={awayTeam?.name}
              homeTeamName={homeTeam?.name}
              variant="detail"
            />

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

            <div className="game-detail-tabs" role="tablist" aria-label="Game detail sections">
              <GameDetailTabButton id="comparison" label="Team Comparison" activeTab={activeTab} onSelect={setActiveTab} />
              <GameDetailTabButton id="team-stats" label="Player Stats" activeTab={activeTab} onSelect={setActiveTab} />
            </div>

            {activeTab === 'comparison' && <section className="detail-game-stats" aria-label="Game team statistics">
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
            </section>}

            {activeTab === 'team-stats' && (
              <section className="selected-team-stats" aria-label="Player statistics">
                <section className="player-stats-selection" aria-label="Player statistics">
                  <div className="section-heading detail-section-heading">
                    <p className="eyebrow">Player stats</p>
                    <h2>Choose a team</h2>
                  </div>
                  <div className="team-stat-selector">
                    <TeamStatSelector
                      team={awayTeam}
                      teamId={game.away_team_id}
                      selectedTeamId={selectedTeamId}
                      onSelect={handleTeamSelect}
                      fallback="A"
                    />
                    <TeamStatSelector
                      team={homeTeam}
                      teamId={game.home_team_id}
                      selectedTeamId={selectedTeamId}
                      onSelect={handleTeamSelect}
                      fallback="H"
                    />
                  </div>
                  {showFullTeamStats && (
                    <FullTeamStatsPanel
                      isLoading={isLoadingFullTeamStats}
                      error={fullTeamStatsError}
                      playerStats={playerStats}
                      players={players}
                    />
                  )}
                </section>
              </section>
            )}

          </>
        )}
      </section>
    </main>
  )
}