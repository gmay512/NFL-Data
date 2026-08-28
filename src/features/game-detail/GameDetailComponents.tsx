import { useMemo, useState } from 'react'
import { formatValue } from '../../lib/game-format'
import {
  getPlayerStatCategory,
  getPlayerStatGroupOrder,
  type PlayerStatCategory,
} from '../../lib/player-stats'
import type { GamePlayerStatRow, GameTeamStatRow, PlayerRow, TeamRow } from '../../types/nfl'

export type GameDetailTab = 'comparison' | 'team-stats'

const playerStatCategories: Array<{ id: PlayerStatCategory; label: string }> = [
  { id: 'offense', label: 'Offense' },
  { id: 'defense', label: 'Defense' },
  { id: 'specialTeams', label: 'Special Teams' },
]

export function GameDetailTabButton({
  id,
  label,
  activeTab,
  onSelect,
}: {
  id: GameDetailTab
  label: string
  activeTab: GameDetailTab
  onSelect: (tab: GameDetailTab) => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === id}
      className={activeTab === id ? 'is-active' : ''}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  )
}

export function TeamStatSelector({
  team,
  teamId,
  selectedTeamId,
  onSelect,
  fallback,
}: {
  team?: TeamRow
  teamId: number | null
  selectedTeamId: number | null
  onSelect: (teamId: number) => void
  fallback: string
}) {
  if (teamId == null) return null

  return (
    <button
      type="button"
      className={`team-stat-selector-button ${selectedTeamId === teamId ? 'is-selected' : ''}`}
      onClick={() => onSelect(teamId)}
    >
      <span className="team-mark detail-team-mark">
        {team?.logo_url ? <img src={team.logo_url} alt="" /> : fallback}
      </span>
      <span>{team?.name ?? `Team ${teamId}`}</span>
    </button>
  )
}

export function FullTeamStatsPanel({
  isLoading,
  error,
  playerStats,
  players,
}: {
  isLoading: boolean
  error: string | null
  playerStats: GamePlayerStatRow[]
  players: PlayerRow[]
}) {
  const [selectedCategory, setSelectedCategory] = useState<PlayerStatCategory>('offense')

  const statGroups = useMemo(() => {
    const playerById = new Map(players.map((player) => [player.id, player]))
    const byGroup = new Map<string, Map<number, Map<string, string | null>>>()
    for (const stat of playerStats) {
      const group = stat.stat_group || 'Other'
      const playersInGroup = byGroup.get(group) ?? new Map<number, Map<string, string | null>>()
      const playerStats = playersInGroup.get(stat.player_id) ?? new Map<string, string | null>()
      playerStats.set(stat.stat_name, stat.stat_value)
      playersInGroup.set(stat.player_id, playerStats)
      byGroup.set(group, playersInGroup)
    }

    return Array.from(byGroup.entries())
      .map(([group, playersInGroup]) => {
        const statNames = Array.from(
          new Set(Array.from(playersInGroup.values()).flatMap((stats) => Array.from(stats.keys()))),
        )
          .filter((statName) =>
            Array.from(playersInGroup.values()).some((stats) => {
              const value = stats.get(statName)
              return value != null && value !== ''
            }),
          )
          .sort((left, right) => left.localeCompare(right))
        const rows = Array.from(playersInGroup.entries())
          .map(([playerId, stats]) => ({
            playerId,
            playerName: playerById.get(playerId)?.name ?? `Player ${playerId}`,
            position: playerById.get(playerId)?.position ?? null,
            stats,
          }))
          .sort((left, right) => left.playerName.localeCompare(right.playerName))
        return { group, statNames, rows }
      })
      .sort((left, right) => left.group.localeCompare(right.group))
  }, [playerStats, players])
  const categoryStatGroups = statGroups
    .filter((group) => getPlayerStatCategory(group.group) === selectedCategory)
    .sort((left, right) => {
      const orderDifference =
        getPlayerStatGroupOrder(left.group, selectedCategory) - getPlayerStatGroupOrder(right.group, selectedCategory)
      return orderDifference || left.group.localeCompare(right.group)
    })
    .map((group) => {
      if (selectedCategory !== 'offense') return group

      const yardsStatName = group.statNames.find((statName) => statName.toLowerCase().includes('yard'))
      if (!yardsStatName) return group

      return {
        ...group,
        rows: [...group.rows].sort((left, right) => {
          const leftYards = Number.parseFloat(left.stats.get(yardsStatName) ?? '')
          const rightYards = Number.parseFloat(right.stats.get(yardsStatName) ?? '')
          const leftValue = Number.isFinite(leftYards) ? leftYards : Number.NEGATIVE_INFINITY
          const rightValue = Number.isFinite(rightYards) ? rightYards : Number.NEGATIVE_INFINITY
          return rightValue - leftValue || left.playerName.localeCompare(right.playerName)
        }),
      }
    })

  if (isLoading) {
    return <p className="stats-loading-message">Loading player statistics from API-Sports…</p>
  }

  if (error) {
    return <p className="stats-loading-message is-error">{error}</p>
  }

  if (statGroups.length === 0) {
    return <p className="stats-loading-message">Player statistics are not available for this team yet.</p>
  }

  return (
    <section className="full-team-stats-panel" aria-label="Player statistics">
      <div className="section-heading detail-section-heading">
        <p className="eyebrow">Player stats</p>
        <h2>Game statistics</h2>
      </div>
      <div className="player-stat-category-tabs" role="tablist" aria-label="Player statistic categories">
        {playerStatCategories.map((category) => (
          <button
            key={category.id}
            type="button"
            role="tab"
            aria-selected={selectedCategory === category.id}
            className={selectedCategory === category.id ? 'is-selected' : ''}
            onClick={() => setSelectedCategory(category.id)}
          >
            {category.label}
          </button>
        ))}
      </div>
      <div className="player-stat-tables">
        {categoryStatGroups.map((group) => (
          <section key={group.group} className="player-stat-table-section" aria-label={`${group.group} player statistics`}>
            <h3>{group.group}</h3>
            <div className="table-wrap">
              <table className="player-stat-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    {group.statNames.map((statName) => <th key={statName}>{statName}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.playerId}>
                      <th scope="row">
                        {row.playerName}
                        {row.position && <small>{row.position}</small>}
                      </th>
                      {group.statNames.map((statName) => <td key={statName}>{formatValue(row.stats.get(statName))}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {categoryStatGroups.length === 0 && (
          <p className="player-stat-category-empty">
            No {selectedCategory === 'specialTeams' ? 'special teams' : selectedCategory} statistics are available for this team.
          </p>
        )}
      </div>
    </section>
  )
}

export function GameStatsTable({
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
              <td>{formatValue(awayValue)}</td>
              <th scope="row">{label}</th>
              <td>{formatValue(homeValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
