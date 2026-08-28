import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { refreshGame, refreshGameStats } from '../api/app-api'
import {
  getGame,
  getGamePlayerStats,
  getGameTeamStats,
  getPlayersByIds,
  getTeamGameOverview,
} from '../data/nfl-repository'
import { RosterBucket } from '../features/team-detail/TeamDetailComponents'
import { formatDetailGameStatus, formatValue } from '../lib/game-format'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import { shouldRefreshGame } from '../lib/game-sync'
import {
  getPlayerUnit,
  groupPlayerStats,
  type PlayerUnit,
} from '../lib/player-stats'
import type { GamePlayerStatRow, GameRow, GameTeamStatRow, PlayerRow, TeamRow } from '../types/nfl'

type TeamPageState = {
  game: GameRow | null
  team: TeamRow | null
  opponent: TeamRow | null
  teamStats: GameTeamStatRow | null
  playerStats: GamePlayerStatRow[]
  players: PlayerRow[]
}

const INITIAL_STATE: TeamPageState = {
  game: null,
  team: null,
  opponent: null,
  teamStats: null,
  playerStats: [],
  players: [],
}

const playerUnits: Array<{ id: PlayerUnit; label: string }> = [
  { id: 'offense', label: 'Offense' },
  { id: 'defense', label: 'Defense' },
  { id: 'specialTeams', label: 'Special Teams' },
]

export function GameTeamDetailPage() {
  const { gameId, teamId } = useParams()
  const location = useLocation()
  const [data, setData] = useState<TeamPageState>(INITIAL_STATE)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingApiStats, setIsLoadingApiStats] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [selectedUnit, setSelectedUnit] = useState<PlayerUnit>('offense')
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(
    async (showLoader: boolean, refreshFromApi = true) => {
      if (!supabase || !gameId || !teamId) {
        setIsLoading(false)
        setIsLoadingApiStats(false)
        return
      }

      if (showLoader) setIsLoading(true)
      setIsLoadingApiStats(false)
      setError(null)

      const gameIdValue = Number(gameId)
      const teamIdValue = Number(teamId)
      if (!Number.isFinite(gameIdValue) || !Number.isFinite(teamIdValue)) {
        setError('Invalid game or team id.')
        setIsLoading(false)
        setIsLoadingApiStats(false)
        return
      }

      let overview
      try {
        overview = await getTeamGameOverview(gameIdValue, teamIdValue)
      } catch (overviewError) {
        setError(overviewError instanceof Error ? overviewError.message : 'Could not load team details.')
        setIsLoading(false)
        setIsLoadingApiStats(false)
        return
      }

      let game = overview.game
      const teams = overview.teams
      let teamStats = overview.teamStats
      let playerStats = overview.playerStats
      const refreshCurrentGame = refreshFromApi && game ? shouldRefreshGame(game) : false

      if (refreshCurrentGame) {
        try {
          await refreshGame(gameIdValue)
          game = await getGame(gameIdValue)
        } catch (gameRefreshError) {
          setError(gameRefreshError instanceof Error ? gameRefreshError.message : 'Failed to refresh game.')
        }
      }

      const loadTeamStats = refreshCurrentGame || teamStats == null
      const loadPlayerStats = refreshCurrentGame || playerStats.length === 0
      if (game && (loadTeamStats || loadPlayerStats)) {
        setIsLoadingApiStats(true)
        try {
          await refreshGameStats(gameIdValue, teamIdValue, {
            loadTeamStats,
            loadPlayerStats,
          })
          const [refreshedTeamStats, refreshedPlayerStats] = await Promise.all([
            getGameTeamStats(gameIdValue, teamIdValue),
            getGamePlayerStats(gameIdValue, teamIdValue),
          ])
          teamStats = refreshedTeamStats[0] ?? null
          playerStats = refreshedPlayerStats
        } catch (statsLoadError) {
          setError(statsLoadError instanceof Error ? statsLoadError.message : 'Failed to load game statistics.')
        } finally {
          setIsLoadingApiStats(false)
        }
      }

      const uniquePlayerIds = Array.from(new Set(playerStats.map((row) => row.player_id)))
      let players: PlayerRow[] = []
      if (uniquePlayerIds.length > 0) {
        try {
          players = await getPlayersByIds(uniquePlayerIds)
        } catch (playersError) {
          setError(playersError instanceof Error ? playersError.message : 'Could not load players.')
          setIsLoading(false)
          setIsLoadingApiStats(false)
          return
        }
      }

      const team = teams.find((item) => item.id === teamIdValue) ?? null
      const opponentId =
        game?.home_team_id === teamIdValue
          ? game.away_team_id
          : game?.away_team_id === teamIdValue
            ? game.home_team_id
            : null
      const opponent = teams.find((item) => item.id === opponentId) ?? null

      setData({
        game,
        team,
        opponent,
        teamStats,
        playerStats,
        players,
      })
      setIsLoading(false)
      setIsLoadingApiStats(false)
    },
    [gameId, teamId],
  )

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadData(true), 0)
    return () => window.clearTimeout(timeoutId)
  }, [loadData])

  const handleRefresh = useCallback(async () => {
    if (!gameId) return

    const gameIdValue = Number(gameId)
    if (!Number.isFinite(gameIdValue)) {
      setError('Invalid game id for refresh.')
      return
    }

    setIsRefreshing(true)
    setError(null)

    try {
      await refreshGame(gameIdValue)
      await refreshGameStats(gameIdValue, Number(teamId), {
        loadTeamStats: true,
        loadPlayerStats: true,
      })

      await loadData(false, false)
      setLastRefreshedAt(new Date())
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh team game stats.')
    } finally {
      setIsRefreshing(false)
    }
  }, [gameId, loadData, teamId])

  const playersById = useMemo(
    () => Object.fromEntries(data.players.map((player) => [player.id, player])) as Record<number, PlayerRow>,
    [data.players],
  )

  const roster = useMemo(() => {
    const groupedByPlayer = new Map<number, GamePlayerStatRow[]>()

    for (const row of data.playerStats) {
      if (row.team_id !== Number(teamId)) continue
      const current = groupedByPlayer.get(row.player_id)
      if (current) {
        current.push(row)
      } else {
        groupedByPlayer.set(row.player_id, [row])
      }
    }

    return Array.from(groupedByPlayer.entries())
      .map(([playerId, stats]) => {
        const player = playersById[playerId]
        return {
          playerId,
          playerName: player?.name ?? `Player ${playerId}`,
          playerImage: player?.image_url ?? null,
          unit: getPlayerUnit(player?.position_group),
          grouped: groupPlayerStats(stats),
        }
      })
      .sort((left, right) => left.playerName.localeCompare(right.playerName))
  }, [data.playerStats, playersById, teamId])

  const unitRoster = useMemo(
    () => roster.filter((player) => player.unit === selectedUnit),
    [roster, selectedUnit],
  )

  const selectedPlayer =
    unitRoster.find((player) => player.playerId === selectedPlayerId) ??
    unitRoster[0] ??
    null

  const selectedTeamHref = gameId && teamId ? `/games/${gameId}/teams/${teamId}` : null
  const opponentHref = gameId && data.opponent ? `/games/${gameId}/teams/${data.opponent.id}` : null
  const dashboardPath = (location.state as { dashboardPath?: string } | null)?.dashboardPath

  return (
    <main>
      <section className="hero detail-hero">
        <p className="eyebrow">Team game details</p>
        <h1>
          {data.team?.name ?? 'Team'} vs {data.opponent?.name ?? 'Opponent'}
        </h1>
        <p className="hero-copy">
          Team-level game stats plus roster details split across offense and defense.
        </p>

        <div className="detail-actions">
          <Link className="week-nav-button detail-back-link" to={`/games/${gameId}`} state={{ dashboardPath }}>
            Back to game
          </Link>
          <button
            type="button"
            className="week-nav-button"
            onClick={handleRefresh}
            disabled={isRefreshing || isLoading || !gameId}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh team stats'}
          </button>
          {lastRefreshedAt && (
            <span className="detail-refresh-time">
              Last refreshed {lastRefreshedAt.toLocaleString()}
            </span>
          )}
          {data.game && <span className="detail-status-pill">{formatDetailGameStatus(data.game)}</span>}
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
          <h2>Team details error</h2>
          <p>{error}</p>
        </section>
      )}

      <section className="panel panel-wide detail-panel">
        {isLoading ? (
          <p className="table-status">
            {isLoadingApiStats ? 'Loading team and player stats from API-Sports...' : 'Loading team details...'}
          </p>
        ) : !data.game || !data.team ? (
          <p className="table-status">No team details found for this game.</p>
        ) : (
          <>
            <div className="team-game-header">
              {selectedTeamHref ? (
                <Link
                  className="team-game-card team-game-card-link"
                  to={selectedTeamHref}
                  state={{ dashboardPath }}
                  aria-label={`View ${data.team.name} team details`}
                >
                  <div className="team-mark team-game-mark">
                    {data.team.logo_url ? <img src={data.team.logo_url} alt="" /> : <span>T</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Selected team</p>
                    <h2>{data.team.name}</h2>
                  </div>
                </Link>
              ) : (
                <div className="team-game-card">
                  <div className="team-mark team-game-mark">
                    {data.team.logo_url ? <img src={data.team.logo_url} alt="" /> : <span>T</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Selected team</p>
                    <h2>{data.team.name}</h2>
                  </div>
                </div>
              )}
              {opponentHref ? (
                <Link
                  className="team-game-card team-game-card-link"
                  to={opponentHref}
                  state={{ dashboardPath }}
                  aria-label={`View ${data.opponent?.name ?? 'Opponent'} team details`}
                >
                  <div className="team-mark team-game-mark">
                    {data.opponent?.logo_url ? <img src={data.opponent.logo_url} alt="" /> : <span>O</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Opponent</p>
                    <h2>{data.opponent?.name ?? 'Unknown opponent'}</h2>
                  </div>
                </Link>
              ) : (
                <div className="team-game-card">
                  <div className="team-mark team-game-mark">
                    {data.opponent?.logo_url ? <img src={data.opponent.logo_url} alt="" /> : <span>O</span>}
                  </div>
                  <div>
                    <p className="game-card-label">Opponent</p>
                    <h2>{data.opponent?.name ?? 'Unknown opponent'}</h2>
                  </div>
                </div>
              )}
            </div>

            <div className="detail-grid">
              <article className="stat-card detail-stat">
                <p className="stat-label">Possession</p>
                <p className="stat-value">{formatValue(data.teamStats?.possession)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Total yards</p>
                <p className="stat-value">{formatValue(data.teamStats?.yards_total)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Passing yards</p>
                <p className="stat-value">{formatValue(data.teamStats?.pass_yards)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Rushing yards</p>
                <p className="stat-value">{formatValue(data.teamStats?.rush_yards)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Third down</p>
                <p className="stat-value">{formatValue(data.teamStats?.third_down_eff)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Fourth down</p>
                <p className="stat-value">{formatValue(data.teamStats?.fourth_down_eff)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Turnovers</p>
                <p className="stat-value">{formatValue(data.teamStats?.turnovers_total)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Points against</p>
                <p className="stat-value">{formatValue(data.teamStats?.points_against)}</p>
              </article>
            </div>

            <section className="team-roster-section" aria-label="Team roster with game stats">
              <div className="section-heading detail-section-heading">
                <p className="eyebrow">Roster</p>
                <h2>Player stats by unit</h2>
              </div>

              {roster.length === 0 ? (
                <p className="table-status">No player stats available for this team in this game.</p>
              ) : (
                <div className="player-stats-explorer">
                  <div className="player-picker" aria-label="Players with game statistics">
                    <div className="player-unit-tabs" role="tablist" aria-label="Player units">
                      {playerUnits.map((unit) => (
                        <button
                          key={unit.id}
                          type="button"
                          role="tab"
                          aria-selected={selectedUnit === unit.id}
                          className={selectedUnit === unit.id ? 'is-selected' : ''}
                          onClick={() => setSelectedUnit(unit.id)}
                        >
                          {unit.label}
                        </button>
                      ))}
                    </div>
                    <p className="player-picker-label">{playerUnits.find((unit) => unit.id === selectedUnit)?.label} players</p>
                    <div className="player-picker-list">
                      {unitRoster.map((player) => {
                        const statCount =
                          player.grouped.offense.reduce((count, group) => count + group.entries.length, 0) +
                          player.grouped.defense.reduce((count, group) => count + group.entries.length, 0) +
                          player.grouped.specialTeams.reduce((count, group) => count + group.entries.length, 0)
                        return (
                          <button
                            key={player.playerId}
                            type="button"
                            className={`player-picker-button ${selectedPlayer?.playerId === player.playerId ? 'is-selected' : ''}`}
                            onClick={() => setSelectedPlayerId(player.playerId)}
                          >
                            <span className="roster-player-avatar">
                              {player.playerImage ? <img src={player.playerImage} alt="" /> : 'P'}
                            </span>
                            <span>{player.playerName}</span>
                            <small>{statCount}</small>
                          </button>
                        )
                      })}
                      {unitRoster.length === 0 && <p className="player-picker-empty">No {selectedUnit === 'specialTeams' ? 'special teams' : selectedUnit} players recorded.</p>}
                    </div>
                  </div>

                  {selectedPlayer && (
                    <article className="roster-card player-stats-detail">
                      <header className="roster-card-head">
                        <div className="roster-player-avatar">
                          {selectedPlayer.playerImage ? <img src={selectedPlayer.playerImage} alt="" /> : <span>P</span>}
                        </div>
                        <div>
                          <p className="game-card-label">Selected player</p>
                          <h3>{selectedPlayer.playerName}</h3>
                        </div>
                      </header>

                      <RosterBucket
                        title={playerUnits.find((unit) => unit.id === selectedUnit)?.label ?? 'Player stats'}
                        groups={[
                          ...selectedPlayer.grouped.offense,
                          ...selectedPlayer.grouped.defense,
                          ...selectedPlayer.grouped.specialTeams,
                        ]}
                      />
                    </article>
                  )}
                  {!selectedPlayer && (
                    <p className="player-stats-empty">Select a unit with recorded player statistics to view details.</p>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </section>
    </main>
  )
}