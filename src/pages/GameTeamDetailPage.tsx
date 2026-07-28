import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GamePlayerStatRow, GameRow, GameTeamStatRow, PlayerRow, TeamRow } from '../types/nfl'

type PlayerStatsBucket = {
  offense: GroupedStats[]
  defense: GroupedStats[]
  other: GroupedStats[]
}

type GroupedStats = {
  group: string
  entries: Array<{ statName: string; statValue: string | null }>
}

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

const offenseKeywords = ['passing', 'rushing', 'receiving', 'kicking', 'punt', 'return', 'offense', 'offence']
const defenseKeywords = ['defense', 'defence', 'tackle', 'interception', 'sack', 'coverage', 'fumble']

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

function classifyGroup(group: string) {
  const normalized = group.trim().toLowerCase()
  if (offenseKeywords.some((keyword) => normalized.includes(keyword))) return 'offense' as const
  if (defenseKeywords.some((keyword) => normalized.includes(keyword))) return 'defense' as const
  return 'other' as const
}

function groupPlayerStats(rows: GamePlayerStatRow[]): PlayerStatsBucket {
  const groupedByBucket: Record<'offense' | 'defense' | 'other', Map<string, GroupedStats>> = {
    offense: new Map(),
    defense: new Map(),
    other: new Map(),
  }

  for (const row of rows) {
    const group = row.stat_group || 'Unknown'
    const bucket = classifyGroup(group)
    const current = groupedByBucket[bucket].get(group)

    if (current) {
      current.entries.push({ statName: row.stat_name, statValue: row.stat_value })
      continue
    }

    groupedByBucket[bucket].set(group, {
      group,
      entries: [{ statName: row.stat_name, statValue: row.stat_value }],
    })
  }

  const toSortedArray = (map: Map<string, GroupedStats>) =>
    Array.from(map.values()).sort((left, right) => left.group.localeCompare(right.group))

  return {
    offense: toSortedArray(groupedByBucket.offense),
    defense: toSortedArray(groupedByBucket.defense),
    other: toSortedArray(groupedByBucket.other),
  }
}

export function GameTeamDetailPage() {
  const { gameId, teamId } = useParams()
  const [data, setData] = useState<TeamPageState>(INITIAL_STATE)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(
    async (showLoader: boolean) => {
      if (!supabase || !gameId || !teamId) {
        setIsLoading(false)
        return
      }

      if (showLoader) setIsLoading(true)
      setError(null)

      const gameIdValue = Number(gameId)
      const teamIdValue = Number(teamId)
      if (!Number.isFinite(gameIdValue) || !Number.isFinite(teamIdValue)) {
        setError('Invalid game or team id.')
        setIsLoading(false)
        return
      }

      const [gameResult, teamsResult, teamStatsResult, playerStatsResult] = await Promise.all([
        supabase.from('games').select('*').eq('id', gameIdValue).maybeSingle(),
        supabase.from('teams').select('id, name, logo_url, created_at').order('id', { ascending: true }),
        supabase.from('game_team_stats').select('*').eq('game_id', gameIdValue).eq('team_id', teamIdValue).maybeSingle(),
        supabase.from('game_player_stats').select('*').eq('game_id', gameIdValue).eq('team_id', teamIdValue),
      ])

      const firstError = [gameResult, teamsResult, teamStatsResult, playerStatsResult].find((result) => result.error)?.error
      if (firstError) {
        setError(firstError.message)
        setIsLoading(false)
        return
      }

      const game = (gameResult.data ?? null) as GameRow | null
      const teams = (teamsResult.data ?? []) as TeamRow[]
      const playerStats = (playerStatsResult.data ?? []) as GamePlayerStatRow[]

      const uniquePlayerIds = Array.from(new Set(playerStats.map((row) => row.player_id)))
      let players: PlayerRow[] = []
      if (uniquePlayerIds.length > 0) {
        const playersResult = await supabase
          .from('players')
          .select('id, name, image_url, created_at')
          .in('id', uniquePlayerIds)

        if (playersResult.error) {
          setError(playersResult.error.message)
          setIsLoading(false)
          return
        }

        players = (playersResult.data ?? []) as PlayerRow[]
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
        teamStats: (teamStatsResult.data ?? null) as GameTeamStatRow | null,
        playerStats,
        players,
      })
      setIsLoading(false)
    },
    [gameId, teamId],
  )

  useEffect(() => {
    void loadData(true)
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
      const response = await fetch('/api/refresh-game-team-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: gameIdValue }),
      })

      const payload = (await response.json()) as { error?: string; rows?: GameTeamStatRow[] }
      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to refresh team game stats.')
      }

      const updatedTeamStats = payload.rows?.find((row) => row.team_id === Number(teamId)) ?? null
      if (updatedTeamStats) {
        setData((current) => ({
          ...current,
          teamStats: updatedTeamStats,
        }))
      }

      await loadData(false)
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
          grouped: groupPlayerStats(stats),
        }
      })
      .sort((left, right) => left.playerName.localeCompare(right.playerName))
  }, [data.playerStats, playersById])

  const selectedTeamHref = gameId && teamId ? `/games/${gameId}/teams/${teamId}` : null
  const opponentHref = gameId && data.opponent ? `/games/${gameId}/teams/${data.opponent.id}` : null

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
          <Link className="week-nav-button detail-back-link" to={`/games/${gameId}`}>
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
          {data.game && <span className="detail-status-pill">{formatGameStatus(data.game)}</span>}
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
          <p className="table-status">Loading team details...</p>
        ) : !data.game || !data.team ? (
          <p className="table-status">No team details found for this game.</p>
        ) : (
          <>
            <div className="team-game-header">
              {selectedTeamHref ? (
                <Link className="team-game-card team-game-card-link" to={selectedTeamHref} aria-label={`View ${data.team.name} team details`}>
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
                <p className="stat-value">{renderValue(data.teamStats?.possession)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Total yards</p>
                <p className="stat-value">{renderValue(data.teamStats?.yards_total)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Passing yards</p>
                <p className="stat-value">{renderValue(data.teamStats?.pass_yards)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Rushing yards</p>
                <p className="stat-value">{renderValue(data.teamStats?.rush_yards)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Third down</p>
                <p className="stat-value">{renderValue(data.teamStats?.third_down_eff)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Fourth down</p>
                <p className="stat-value">{renderValue(data.teamStats?.fourth_down_eff)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Turnovers</p>
                <p className="stat-value">{renderValue(data.teamStats?.turnovers_total)}</p>
              </article>
              <article className="stat-card detail-stat">
                <p className="stat-label">Points against</p>
                <p className="stat-value">{renderValue(data.teamStats?.points_against)}</p>
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
                <div className="roster-grid">
                  {roster.map((player) => (
                    <article key={player.playerId} className="roster-card">
                      <header className="roster-card-head">
                        <div className="roster-player-avatar">
                          {player.playerImage ? <img src={player.playerImage} alt="" /> : <span>P</span>}
                        </div>
                        <div>
                          <p className="game-card-label">Player</p>
                          <h3>{player.playerName}</h3>
                        </div>
                      </header>

                      <RosterBucket title="Offense" groups={player.grouped.offense} />
                      <RosterBucket title="Defense" groups={player.grouped.defense} />
                      <RosterBucket title="Other" groups={player.grouped.other} />
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </section>
    </main>
  )
}

function RosterBucket({ title, groups }: { title: string; groups: GroupedStats[] }) {
  if (!groups.length) return null

  return (
    <section className="roster-bucket" aria-label={`${title} stats`}>
      <h4>{title}</h4>
      <div className="roster-group-list">
        {groups.map((group) => (
          <div key={group.group} className="roster-group">
            <p>{group.group}</p>
            <ul>
              {group.entries.map((entry) => (
                <li key={`${group.group}-${entry.statName}`}>
                  <span>{entry.statName}</span>
                  <strong>{renderValue(entry.statValue)}</strong>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}