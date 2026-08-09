import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GamePlayerStatRow, GameRow, GameTeamStatRow, PlayerRow, TeamRow } from '../types/nfl'

type GameDetailTab = 'comparison' | 'team-stats'

type PlayerStatCategory = 'offense' | 'defense' | 'specialTeams'

const playerStatCategories: Array<{ id: PlayerStatCategory; label: string }> = [
  { id: 'offense', label: 'Offense' },
  { id: 'defense', label: 'Defense' },
  { id: 'specialTeams', label: 'Special Teams' },
]

function getPlayerStatCategory(statGroup: string): PlayerStatCategory {
  const normalized = statGroup.trim().toLowerCase()
  if (['rushing', 'receiving', 'passing', 'fumbles'].some((name) => normalized.includes(name))) return 'offense'
  if (['kicking', 'kick', 'punt', 'return'].some((name) => normalized.includes(name))) return 'specialTeams'
  return 'defense'
}

function getPlayerStatGroupOrder(statGroup: string, category: PlayerStatCategory) {
  const normalized = statGroup.trim().toLowerCase()
  if (category === 'specialTeams') {
    if (normalized.includes('kick') && !normalized.includes('return')) return 0
    if (normalized.includes('kick return')) return 1
    if (normalized.includes('punt') && !normalized.includes('return')) return 2
    if (normalized.includes('punt return')) return 3
    return 4
  }

  const order = category === 'offense' ? ['passing', 'rushing', 'receiving', 'fumbles'] : []
  const index = order.findIndex((name) => normalized.includes(name))
  return index === -1 ? order.length : index
}

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

function needsGameRefresh(game: GameRow | null, hasTeamStats: boolean) {
  if (!game) return true
  if (hasTeamStats || game.status_short !== 'NS') return false
  if (game.game_timestamp == null) return true

  return game.game_timestamp * 1000 <= Date.now()
}

export function GameDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const [game, setGame] = useState<GameRow | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamStats, setTeamStats] = useState<GameTeamStatRow[]>([])
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

      if (needsGameRefresh(loadedGame, storedStats.length > 0)) {
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
  const dashboardPath = (location.state as { dashboardPath?: string } | null)?.dashboardPath ?? '/games'

  useEffect(() => {
    if (!game) return
    if (selectedTeamId !== game.away_team_id && selectedTeamId !== game.home_team_id) {
      setSelectedTeamId(game.away_team_id ?? game.home_team_id ?? null)
    }
  }, [game, selectedTeamId])

  useEffect(() => {
    setShowFullTeamStats(false)
    setPlayerStats([])
    setPlayers([])
    setFullTeamStatsError(null)
  }, [selectedTeamId])

  const loadFullTeamStats = useCallback(async () => {
    if (!supabase || !game || !selectedTeamId) return

    setShowFullTeamStats(true)
    setIsLoadingFullTeamStats(true)
    setFullTeamStatsError(null)
    try {
      let { data: storedPlayerStats, error: playerStatsError } = await supabase
        .from('game_player_stats')
        .select('*')
        .eq('game_id', game.id)
        .eq('team_id', selectedTeamId)
      if (playerStatsError) throw playerStatsError

      if ((storedPlayerStats ?? []).length === 0) {
        const response = await fetch('/api/refresh-game-stats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameId: game.id,
            teamId: selectedTeamId,
            loadTeamStats: false,
            loadPlayerStats: true,
          }),
        })
        const payload = (await response.json()) as { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Could not load player statistics.')

        const refreshedPlayerStats = await supabase
          .from('game_player_stats')
          .select('*')
          .eq('game_id', game.id)
          .eq('team_id', selectedTeamId)
        if (refreshedPlayerStats.error) throw refreshedPlayerStats.error
        storedPlayerStats = refreshedPlayerStats.data
      }

      const loadedPlayerStats = (storedPlayerStats ?? []) as GamePlayerStatRow[]
      const playerIds = Array.from(new Set(loadedPlayerStats.map((stat) => stat.player_id)))
      let loadedPlayers: PlayerRow[] = []
      if (playerIds.length > 0) {
        const { data: playerRows, error: playersError } = await supabase
          .from('players')
          .select('id, name, image_url, position_group, created_at')
          .in('id', playerIds)
        if (playersError) throw playersError
        loadedPlayers = (playerRows ?? []) as PlayerRow[]
      }

      setPlayerStats(loadedPlayerStats)
      setPlayers(loadedPlayers)
    } catch (loadError) {
      setFullTeamStatsError(loadError instanceof Error ? loadError.message : 'Could not load player statistics.')
    } finally {
      setIsLoadingFullTeamStats(false)
    }
  }, [game, selectedTeamId])

  useEffect(() => {
    if (!game || !selectedTeamId) return
    void loadFullTeamStats()
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

      {!isLoading && game && (
        <section className="game-meta-card game-meta-panel">
          <dl>
            <div>
              <dt>Season</dt>
              <dd>{renderValue(game.season)}</dd>
            </div>
            <div>
              <dt>Week</dt>
              <dd>{renderValue(game.week)}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{renderValue(game.game_date)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{renderValue(game.game_time)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{formatGameStatus(game)}</dd>
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
                <strong className="detail-team-score">{renderValue(game.away_total)}</strong>
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
                <strong className="detail-team-score">{renderValue(game.home_total)}</strong>
              </div>
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
                      onSelect={setSelectedTeamId}
                      fallback="A"
                    />
                    <TeamStatSelector
                      team={homeTeam}
                      teamId={game.home_team_id}
                      selectedTeamId={selectedTeamId}
                      onSelect={setSelectedTeamId}
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

function GameDetailTabButton({
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

function TeamStatSelector({
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

function FullTeamStatsPanel({
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
  const playerById = new Map(players.map((player) => [player.id, player]))
  const [selectedCategory, setSelectedCategory] = useState<PlayerStatCategory>('offense')

  const statGroups = useMemo(() => {
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
  }, [playerById, playerStats])
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
                      {group.statNames.map((statName) => <td key={statName}>{renderValue(row.stats.get(statName))}</td>)}
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