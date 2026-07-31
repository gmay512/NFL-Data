import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GamePlayerStatRow, GameRow, GameTeamStatRow, PlayerRow, TeamRow } from '../types/nfl'

type GameDetailTab = 'box-score' | 'comparison' | 'team-stats'

type PlayerUnit = 'offense' | 'defense' | 'specialTeams'

type GroupedStats = {
  group: string
  entries: Array<{ statName: string; statValue: string | null }>
}

const playerUnits: Array<{ id: PlayerUnit; label: string }> = [
  { id: 'offense', label: 'Offense' },
  { id: 'defense', label: 'Defense' },
  { id: 'specialTeams', label: 'Special Teams' },
]

function getPlayerUnit(positionGroup: string | null | undefined): PlayerUnit | null {
  const normalized = positionGroup?.trim().toLowerCase()
  if (normalized === 'offense' || normalized === 'offence') return 'offense'
  if (normalized === 'defense' || normalized === 'defence') return 'defense'
  if (normalized === 'special teams' || normalized === 'special team') return 'specialTeams'
  return null
}

function groupPlayerStats(rows: GamePlayerStatRow[]): GroupedStats[] {
  const groups = new Map<string, GroupedStats>()

  for (const row of rows) {
    const group = row.stat_group || 'Unknown'
    const current = groups.get(group)
    if (current) {
      current.entries.push({ statName: row.stat_name, statValue: row.stat_value })
    } else {
      groups.set(group, { group, entries: [{ statName: row.stat_name, statValue: row.stat_value }] })
    }
  }

  return Array.from(groups.values()).sort((left, right) => left.group.localeCompare(right.group))
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

export function GameDetailPage() {
  const { id } = useParams()
  const location = useLocation()
  const [game, setGame] = useState<GameRow | null>(null)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamStats, setTeamStats] = useState<GameTeamStatRow[]>([])
  const [activeTab, setActiveTab] = useState<GameDetailTab>('box-score')
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
  const selectedTeam = selectedTeamId ? teamMap[selectedTeamId] : undefined
  const selectedTeamStats = selectedTeamId ? teamStats.find((stats) => stats.team_id === selectedTeamId) : undefined
  const selectedTeamHref = game && selectedTeamId ? `/games/${game.id}/teams/${selectedTeamId}` : null
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

  const loadFullTeamStats = async () => {
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
  }

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

            <div className="game-meta-grid">
              <StatMetric label="Season" value={game.season} />
              <StatMetric label="Week" value={game.week} />
              <StatMetric label="Date" value={game.game_date} />
              <StatMetric label="Time" value={game.game_time} />
              <StatMetric label="Status" value={formatGameStatus(game)} />
              <StatMetric label="Venue" value={[game.venue_name, game.venue_city].filter(Boolean).join(', ') || '—'} />
            </div>

            <div className="game-detail-tabs" role="tablist" aria-label="Game detail sections">
              <GameDetailTabButton id="box-score" label="Box Score" activeTab={activeTab} onSelect={setActiveTab} />
              <GameDetailTabButton id="comparison" label="Team Comparison" activeTab={activeTab} onSelect={setActiveTab} />
              <GameDetailTabButton id="team-stats" label="Team Stats" activeTab={activeTab} onSelect={setActiveTab} />
            </div>

            {activeTab === 'box-score' && <section className="detail-boxscore" aria-label="Quarter box score">
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
            </section>}

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
              <section className="selected-team-stats" aria-label="Selected team statistics">
                <div className="section-heading detail-section-heading">
                  <p className="eyebrow">Team stats</p>
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

                {isLoadingStats ? (
                  <p className="stats-loading-message">Loading team stats from API-Sports…</p>
                ) : statsError ? (
                  <p className="stats-loading-message is-error">{statsError}</p>
                ) : (
                  <>
                    <div className="detail-grid">
                      <StatMetric label="Possession" value={selectedTeamStats?.possession} />
                      <StatMetric label="Total yards" value={selectedTeamStats?.yards_total} />
                      <StatMetric label="Passing yards" value={selectedTeamStats?.pass_yards} />
                      <StatMetric label="Rushing yards" value={selectedTeamStats?.rush_yards} />
                      <StatMetric label="First downs" value={selectedTeamStats?.fd_total} />
                      <StatMetric label="Third down" value={selectedTeamStats?.third_down_eff} />
                      <StatMetric label="Turnovers" value={selectedTeamStats?.turnovers_total} />
                      <StatMetric label="Points against" value={selectedTeamStats?.points_against} />
                    </div>
                    {selectedTeamHref && (
                      <button type="button" className="team-stats-detail-button" onClick={() => void loadFullTeamStats()}>
                        {showFullTeamStats
                          ? `Refresh ${selectedTeam?.name ?? 'team'} player stats`
                          : `View ${selectedTeam?.name ?? 'team'} player and full stats`}
                      </button>
                    )}
                    {showFullTeamStats && (
                      <FullTeamStatsPanel
                        isLoading={isLoadingFullTeamStats}
                        error={fullTeamStatsError}
                        playerStats={playerStats}
                        players={players}
                      />
                    )}
                  </>
                )}
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

function StatMetric({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <article className="stat-card detail-stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{renderValue(value)}</p>
    </article>
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
  const [selectedUnit, setSelectedUnit] = useState<PlayerUnit>('offense')
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null)
  const roster = useMemo(() => {
    const statsByPlayer = new Map<number, GamePlayerStatRow[]>()
    for (const stat of playerStats) {
      const stats = statsByPlayer.get(stat.player_id) ?? []
      stats.push(stat)
      statsByPlayer.set(stat.player_id, stats)
    }

    return Array.from(statsByPlayer.entries())
      .map(([playerId, stats]) => {
        const player = playerById.get(playerId)
        return {
          playerId,
          playerName: player?.name ?? `Player ${playerId}`,
          playerImage: player?.image_url ?? null,
          unit: getPlayerUnit(player?.position_group),
          groups: groupPlayerStats(stats),
          statCount: stats.length,
        }
      })
      .sort((left, right) => left.playerName.localeCompare(right.playerName))
  }, [playerById, playerStats])
  const unitRoster = useMemo(() => roster.filter((player) => player.unit === selectedUnit), [roster, selectedUnit])
  const selectedPlayer = unitRoster.find((player) => player.playerId === selectedPlayerId) ?? null

  useEffect(() => {
    if (!unitRoster.some((player) => player.playerId === selectedPlayerId)) {
      setSelectedPlayerId(unitRoster[0]?.playerId ?? null)
    }
  }, [selectedPlayerId, unitRoster])

  if (isLoading) {
    return <p className="stats-loading-message">Loading player statistics from API-Sports…</p>
  }

  if (error) {
    return <p className="stats-loading-message is-error">{error}</p>
  }

  if (roster.length === 0) {
    return <p className="stats-loading-message">Player statistics are not available for this team yet.</p>
  }

  return (
    <section className="full-team-stats-panel" aria-label="Player statistics">
      <div className="section-heading detail-section-heading">
        <p className="eyebrow">Player stats</p>
        <h2>Game statistics by unit</h2>
      </div>
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
                onClick={() => {
                  setSelectedUnit(unit.id)
                  setSelectedPlayerId(null)
                }}
              >
                {unit.label}
              </button>
            ))}
          </div>
          <p className="player-picker-label">{playerUnits.find((unit) => unit.id === selectedUnit)?.label} players</p>
          <div className="player-picker-list">
            {unitRoster.map((player) => (
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
                <small>{player.statCount}</small>
              </button>
            ))}
            {unitRoster.length === 0 && (
              <p className="player-picker-empty">
                No {selectedUnit === 'specialTeams' ? 'special teams' : selectedUnit} players recorded.
              </p>
            )}
          </div>
        </div>

        {selectedPlayer ? (
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
            <RosterBucket title={playerUnits.find((unit) => unit.id === selectedUnit)?.label ?? 'Player stats'} groups={selectedPlayer.groups} />
          </article>
        ) : (
          <p className="player-stats-empty">Select a player to view game statistics.</p>
        )}
      </div>
    </section>
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