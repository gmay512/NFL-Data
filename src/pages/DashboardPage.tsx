import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useVisiblePolling } from '../hooks/useVisiblePolling'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import { shouldRefreshGame } from '../lib/game-sync'
import type { GameRow, GameTeamStatRow, LeagueSeasonRow, TeamRow } from '../types/nfl'

type DashboardMode = 'season' | 'live' | 'team'
type SeasonOption = { season: number; current: boolean }

const UNASSIGNED_WEEK = '__unassigned__'
const WEEK_KEY_SEPARATOR = '::'

function getWeekKey(game: GameRow) {
  return [game.stage?.trim() || 'Season', game.week?.trim() || UNASSIGNED_WEEK].join(WEEK_KEY_SEPARATOR)
}

function getWeekLabel(week: string) {
  if (!week || week === UNASSIGNED_WEEK) return 'Schedule'
  const [stage, weekLabel] = week.split(WEEK_KEY_SEPARATOR)
  if (weekLabel === UNASSIGNED_WEEK) return stage
  if (!weekLabel) return stage
  return `${stage} · ${weekLabel}`
}

function getGameStatus(game: GameRow) {
  if (game.status_short === 'FT') return 'Final'
  if (game.status_short === 'NS') return 'Scheduled'
  if (game.status_short === 'HT') return 'Half time'
  if (game.status_short && game.status_timer) return `${game.status_short} ${game.status_timer}`
  return game.status_long || game.status_short || 'Scheduled'
}

function isWinningTeam(game: GameRow, team: 'away' | 'home') {
  if (!['FT', 'AOT'].includes(game.status_short ?? '')) return false
  if (game.away_total == null || game.home_total == null || game.away_total === game.home_total) return false

  return team === 'away' ? game.away_total > game.home_total : game.home_total > game.away_total
}

function getGameDate(game: GameRow) {
  if (!game.game_date) return 'Date pending'

  const [year, month, day] = game.game_date.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const formattedDate = Number.isNaN(date.getTime())
    ? game.game_date
    : new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date)

  if (!game.game_time) return formattedDate

  const [hours, minutes] = game.game_time.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return formattedDate

  const meridiem = hours >= 12 ? 'PM' : 'AM'
  const formattedTime = `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${meridiem}`
  const timeZoneAbbreviation = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
    .formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'ET'

  return `${formattedDate} · ${formattedTime} ${timeZoneAbbreviation}`
}

function renderScore(score: number | null | undefined) {
  return score == null ? '—' : score
}

export function DashboardPage() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [seasons, setSeasons] = useState<SeasonOption[]>([])
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [selectedSeason, setSelectedSeason] = useState(() => searchParams.get('season') ?? '')
  const [selectedWeek, setSelectedWeek] = useState(() => searchParams.get('week') ?? '')
  const [selectedTeamId, setSelectedTeamId] = useState(() => searchParams.get('team') ?? '')
  const [games, setGames] = useState<GameRow[]>([])
  const [teamGameStats, setTeamGameStats] = useState<Record<number, GameTeamStatRow>>({})
  const [mode, setMode] = useState<DashboardMode>(() => {
    const view = searchParams.get('view')
    return view === 'live' || view === 'team' ? view : 'season'
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshingLive, setIsRefreshingLive] = useState(false)
  const [isIngestingSeason, setIsIngestingSeason] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [loadMessage, setLoadMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastLiveCheckedAt, setLastLiveCheckedAt] = useState<Date | null>(null)
  const liveRequestId = useRef(0)

  useEffect(() => {
    const loadDashboardMeta = async () => {
      if (!supabase) {
        setIsLoading(false)
        return
      }

      const [seasonsResult, teamsResult] = await Promise.all([
        supabase.from('league_seasons').select('season_year, is_current').order('season_year', { ascending: false }),
        supabase.from('teams').select('*').order('name', { ascending: true }),
      ])
      const firstError = [seasonsResult, teamsResult].find((result) => result.error)?.error

      if (firstError) {
        setError(firstError.message)
        setIsLoading(false)
        return
      }

      const seasonRows = (seasonsResult.data ?? []) as LeagueSeasonRow[]
      const localSeasons = seasonRows
        .map((row) => ({ season: row.season_year, current: row.is_current }))
        .filter((season, index, all) => all.findIndex((candidate) => candidate.season === season.season) === index)

      let apiSeasons: SeasonOption[] = []
      try {
        const response = await fetch('/api/seasons')
        const payload = (await response.json()) as { seasons?: Array<{ season: number; current: boolean }> }
        if (response.ok) {
          apiSeasons = payload.seasons ?? []
        }
      } catch {
        // Local season metadata remains available when the API is not configured.
      }

      const seasonsByYear = new Map(apiSeasons.map((season) => [season.season, season]))
      for (const season of localSeasons) {
        seasonsByYear.set(season.season, season)
      }
      const availableSeasons = Array.from(seasonsByYear.values()).sort((left, right) => right.season - left.season)

      setSeasons(availableSeasons)
      setTeams((teamsResult.data ?? []) as TeamRow[])
      setSelectedSeason((current) => current || String((availableSeasons.find((season) => season.current) ?? availableSeasons[0])?.season ?? ''))
      setIsLoading(false)
    }

    void loadDashboardMeta()
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadSeasonGames = async () => {
      if (!supabase || !selectedSeason || (mode !== 'season' && mode !== 'team')) return
      const client = supabase
      if (mode === 'team' && !selectedTeamId) {
        if (!cancelled) {
          setGames([])
          setTeamGameStats({})
          setIsLoading(false)
        }
        return
      }

      setIsLoading(true)
      setError(null)

      const fetchGames = async () => {
        let gamesQuery = client
          .from('games')
          .select('*')
          .eq('season', Number(selectedSeason))
          .order('game_timestamp', { ascending: true })

        if (mode === 'team' && selectedTeamId) {
          gamesQuery = gamesQuery.or(`home_team_id.eq.${selectedTeamId},away_team_id.eq.${selectedTeamId}`)
        }

        const result = await gamesQuery
        if (result.error) throw result.error
        return (result.data ?? []) as GameRow[]
      }

      try {
        let loadedGames = await fetchGames()
        const visibleGames =
          mode === 'season' && selectedWeek
            ? loadedGames.filter((game) => getWeekKey(game) === selectedWeek)
            : mode === 'team'
              ? loadedGames
              : []

        if (visibleGames.some((game) => shouldRefreshGame(game))) {
          try {
            const response = await fetch('/api/refresh-season-games', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ season: Number(selectedSeason) }),
            })
            const payload = (await response.json()) as { error?: string }
            if (!response.ok) throw new Error(payload.error ?? 'Could not refresh game scores.')
            loadedGames = await fetchGames()
          } catch (refreshError) {
            if (!cancelled) {
              setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh game scores.')
            }
          }
        }

        if (cancelled) return
        setGames(loadedGames)

        if (mode === 'team' && selectedTeamId && loadedGames.length > 0) {
          const { data: statsData, error: statsError } = await client
            .from('game_team_stats')
            .select('*')
            .eq('team_id', Number(selectedTeamId))
            .in('game_id', loadedGames.map((game) => game.id))
          if (cancelled) return
          if (statsError) {
            setError(statsError.message)
            setTeamGameStats({})
          } else {
            setTeamGameStats(
              Object.fromEntries(((statsData ?? []) as GameTeamStatRow[]).map((stats) => [stats.game_id, stats])),
            )
          }
        } else {
          setTeamGameStats({})
        }
      } catch (gamesError) {
        if (cancelled) return
        setError(gamesError instanceof Error ? gamesError.message : 'Could not load games.')
        setGames([])
        setTeamGameStats({})
      }
      if (!cancelled) setIsLoading(false)
    }

    void loadSeasonGames()
    return () => {
      cancelled = true
    }
  }, [mode, reloadKey, selectedSeason, selectedTeamId, selectedWeek])

  const loadSeason = async () => {
    if (!supabase || !selectedSeason) return

    setIsIngestingSeason(true)
    setError(null)
    setLoadMessage(null)
    try {
      const response = await fetch('/api/ingest-season', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: Number(selectedSeason) }),
      })
      const payload = (await response.json()) as { games?: number; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Could not load this season.')

      const { data: updatedTeams, error: teamsError } = await supabase.from('teams').select('*').order('name', { ascending: true })
      if (teamsError) throw teamsError

      setTeams((updatedTeams ?? []) as TeamRow[])
      setLoadMessage(`Loaded ${payload.games ?? 0} games for the ${selectedSeason} season.`)
      setReloadKey((key) => key + 1)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load this season.')
    } finally {
      setIsIngestingSeason(false)
    }
  }

  const refreshLiveGames = useCallback(async () => {
    if (!supabase) return

    const requestId = ++liveRequestId.current
    setIsRefreshingLive(true)
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/live-games', { method: 'POST' })
      const payload = (await response.json()) as { gameIds?: number[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Could not refresh live games.')
      if (requestId !== liveRequestId.current) return

      const gameIds = payload.gameIds ?? []
      if (!gameIds.length) {
        setGames([])
        setSelectedWeek('')
        setLastLiveCheckedAt(new Date())
        return
      }

      const { data, error: gamesError } = await supabase.from('games').select('*').in('id', gameIds)
      if (gamesError) throw gamesError
      if (requestId !== liveRequestId.current) return

      setGames((data ?? []) as GameRow[])
      setSelectedWeek('')
      setLastLiveCheckedAt(new Date())
    } catch (liveError) {
      if (requestId !== liveRequestId.current) return
      setError(liveError instanceof Error ? liveError.message : 'Could not refresh live games.')
      setGames([])
    } finally {
      if (requestId === liveRequestId.current) {
        setIsLoading(false)
        setIsRefreshingLive(false)
      }
    }
  }, [])

  useVisiblePolling(refreshLiveGames, mode === 'live')

  useEffect(() => {
    if (mode !== 'live') return
    const timeoutId = window.setTimeout(() => void refreshLiveGames(), 0)

    return () => {
      window.clearTimeout(timeoutId)
      liveRequestId.current += 1
    }
  }, [mode, refreshLiveGames])

  const teamById = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team])) as Record<number, TeamRow>, [teams])
  const selectedTeam = selectedTeamId ? teamById[Number(selectedTeamId)] : undefined
  const weeks = useMemo(() => Array.from(new Set(games.map(getWeekKey))), [games])

  useEffect(() => {
    if (mode !== 'season' || isLoading || weeks.length === 0) return
    setSelectedWeek((week) => (weeks.includes(week) ? week : (weeks[0] ?? '')))
  }, [isLoading, mode, weeks])

  useEffect(() => {
    const nextSearchParams = new URLSearchParams()
    if (selectedSeason) nextSearchParams.set('season', selectedSeason)
    if (mode === 'live') {
      nextSearchParams.set('view', 'live')
    } else if (mode === 'team') {
      nextSearchParams.set('view', 'team')
      if (selectedTeamId) nextSearchParams.set('team', selectedTeamId)
    } else if (selectedWeek) {
      nextSearchParams.set('week', selectedWeek)
    }

    if (nextSearchParams.toString() !== searchParams.toString()) {
      setSearchParams(nextSearchParams, { replace: true })
    }
  }, [mode, searchParams, selectedSeason, selectedTeamId, selectedWeek, setSearchParams])

  const displayedGames = useMemo(
    () => (mode === 'season' ? games.filter((game) => getWeekKey(game) === selectedWeek) : games),
    [games, mode, selectedWeek],
  )
  const selectedSeasonLabel = seasons.find((season) => String(season.season) === selectedSeason)?.season
  const dashboardPath = `${location.pathname}${location.search}`

  return (
    <main className="dashboard-page">
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <h1 className="dashboard-logo">
            <img src="/nfl-game-center-logo-white.svg" alt="NFL Game Center" />
          </h1>
          <p>Choose a season, browse its schedule, and open a game for its complete box score.</p>
        </div>
        <div className="dashboard-actions">
          <label className="season-select">
            <span>Season</span>
            <select
              value={selectedSeason}
              onChange={(event) => {
                setMode('season')
                setSelectedSeason(event.target.value)
              }}
              disabled={isLoading || seasons.length === 0}
            >
              <option value="">Select season</option>
              {seasons.map((season) => (
                <option key={season.season} value={season.season}>
                  {season.season}{season.current ? ' · Current' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="dashboard-view-switcher" aria-label="Dashboard view">
            <button
              type="button"
              className={mode === 'season' ? 'is-active' : ''}
              onClick={() => setMode('season')}
            >
              Schedule
            </button>
            <button
              type="button"
              className={mode === 'team' ? 'is-active' : ''}
              onClick={() => setMode('team')}
            >
              Teams
            </button>
          </div>
          <button
            className={`live-button ${mode === 'live' ? 'is-active' : ''}`}
            type="button"
            onClick={() => {
              if (mode === 'live') {
                void refreshLiveGames()
              } else {
                setMode('live')
              }
            }}
            disabled={isRefreshingLive}
          >
            <span className="live-indicator" />
            {isRefreshingLive ? 'Checking live games' : 'Live games'}
          </button>
        </div>
      </section>

      {!hasSupabaseEnv && <StatusMessage title="Database connection required" message="Set the VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY variables to load game data." />}
      {error && <StatusMessage title="Unable to load games" message={error} error />}
      {loadMessage && <StatusMessage title="Season loaded" message={loadMessage} />}

      {mode === 'team' && (
        <section className="team-dashboard-controls" aria-label="Team schedule controls">
          <div>
            <p className="eyebrow">Team games</p>
            <h2>Explore a team’s season</h2>
          </div>
          <label className="season-select team-select">
            <span>Team</span>
            <select value={selectedTeamId} onChange={(event) => setSelectedTeamId(event.target.value)} disabled={teams.length === 0}>
              <option value="">Select team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>
        </section>
      )}

      <section className="schedule-shell" aria-label="Game schedule">
        <aside className="week-sidebar">
          <div className="sidebar-heading">
            <p className="eyebrow">{mode === 'live' ? 'Now playing' : mode === 'team' ? 'Team schedule' : 'Season schedule'}</p>
            <h2>{mode === 'live' ? 'Live games' : mode === 'team' ? selectedTeam?.name ?? 'Select a team' : selectedSeasonLabel ?? 'Select a season'}</h2>
          </div>
          {mode === 'season' ? (
            <div className="week-list">
              {weeks.map((week) => {
                const gameCount = games.filter((game) => getWeekKey(game) === week).length
                return (
                  <button key={week} className={`week-button ${selectedWeek === week ? 'is-active' : ''}`} type="button" onClick={() => setSelectedWeek(week)}>
                    <span>{getWeekLabel(week)}</span>
                    <small>{gameCount}</small>
                  </button>
                )
              })}
            </div>
          ) : mode === 'team' ? (
            <p className="sidebar-note">Select a team to list every stored game and open its complete team and player statistics.</p>
          ) : (
            <>
              <p className="sidebar-note">Scores refresh from API-Sports every 60 seconds while this page is visible.</p>
              {lastLiveCheckedAt && (
                <span className="detail-refresh-time">Last checked {lastLiveCheckedAt.toLocaleTimeString()}</span>
              )}
            </>
          )}
        </aside>

        <div className="games-panel">
          <div className="games-panel-header">
            <div>
              <p className="eyebrow">{mode === 'live' ? 'Live scoreboard' : mode === 'team' ? 'Team results' : 'Games'}</p>
              <h2>{mode === 'live' ? 'In progress' : mode === 'team' ? `${selectedSeasonLabel ?? ''} season` : getWeekLabel(selectedWeek || UNASSIGNED_WEEK)}</h2>
            </div>
            <span>{displayedGames.length} {displayedGames.length === 1 ? 'game' : 'games'}</span>
          </div>

          {isLoading ? (
            <p className="empty-state">Loading games…</p>
          ) : displayedGames.length === 0 ? (
            mode === 'live' ? (
              <p className="empty-state">There are no live NFL games right now.</p>
            ) : mode === 'team' && !selectedTeamId ? (
              <p className="empty-state">Select a team to view its games for the selected season.</p>
            ) : mode === 'team' ? (
              <p className="empty-state">No games are stored for this team in the selected season.</p>
            ) : (
              <div className="empty-season-state">
                <p>No games are stored for the {selectedSeason} season.</p>
                <span>Load its teams, players, schedule, scores, and statistics from API-Sports.</span>
                <button type="button" className="load-season-button" onClick={() => void loadSeason()} disabled={isIngestingSeason}>
                  {isIngestingSeason ? `Loading ${selectedSeason}…` : `Load ${selectedSeason} season`}
                </button>
              </div>
            )
          ) : (
            <div className="game-list">
              {displayedGames.map((game) => {
                const awayTeam = game.away_team_id ? teamById[game.away_team_id] : undefined
                const homeTeam = game.home_team_id ? teamById[game.home_team_id] : undefined
                if (mode === 'team' && selectedTeamId) {
                  return (
                    <ScheduleGameCard
                      key={game.id}
                      game={game}
                      awayTeam={awayTeam}
                      homeTeam={homeTeam}
                      teamId={Number(selectedTeamId)}
                      stats={teamGameStats[game.id]}
                      dashboardPath={dashboardPath}
                    />
                  )
                }

                return (
                  <ScheduleGameCard
                    key={game.id}
                    game={game}
                    awayTeam={awayTeam}
                    homeTeam={homeTeam}
                    dashboardPath={dashboardPath}
                  />
                )
              })}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function TeamMark({ team, fallback }: { team?: TeamRow; fallback: string }) {
  return <span className="team-mark">{team?.logo_url ? <img src={team.logo_url} alt="" /> : fallback}</span>
}

function ScheduleGameCard({
  game,
  awayTeam,
  homeTeam,
  teamId,
  stats,
  dashboardPath,
}: {
  game: GameRow
  awayTeam?: TeamRow
  homeTeam?: TeamRow
  teamId?: number
  stats?: GameTeamStatRow
  dashboardPath: string
}) {
  return (
    <article className={`schedule-game ${teamId ? 'has-team-stats' : ''}`}>
      <Link className="schedule-game-details" to={`/games/${game.id}`} state={{ dashboardPath }}>
        <div className="schedule-game-meta">
          <span>{[game.stage, game.week, getGameStatus(game)].filter(Boolean).join(' · ')}</span>
          <time>{getGameDate(game)}</time>
        </div>
        <div className="schedule-matchup">
          <div className={`schedule-team ${isWinningTeam(game, 'away') ? 'is-winner' : ''}`}>
            <TeamMark team={awayTeam} fallback="A" />
            <div className="schedule-team-name">
              <span>Away</span>
              <strong>{awayTeam?.name ?? `Away team ${game.away_team_id ?? ''}`}</strong>
            </div>
            <b>{renderScore(game.away_total)}</b>
          </div>
          <div className={`schedule-team schedule-team-home ${isWinningTeam(game, 'home') ? 'is-winner' : ''}`}>
            <TeamMark team={homeTeam} fallback="H" />
            <div className="schedule-team-name">
              <span>Home</span>
              <strong>{homeTeam?.name ?? `Home team ${game.home_team_id ?? ''}`}</strong>
            </div>
            <b>{renderScore(game.home_total)}</b>
          </div>
        </div>
        <span className="game-chevron" aria-hidden="true">›</span>
      </Link>
      {teamId && (
        <div className="team-game-stats">
          <div className="team-game-stat-summary">
            <span><b>{renderScore(stats?.yards_total)}</b> yards</span>
            <span><b>{renderScore(stats?.pass_yards)}</b> passing</span>
            <span><b>{renderScore(stats?.rush_yards)}</b> rushing</span>
            <span><b>{renderScore(stats?.turnovers_total)}</b> turnovers</span>
          </div>
          <Link className="team-game-stats-link" to={`/games/${game.id}/teams/${teamId}`} state={{ dashboardPath }}>
            View all stats
          </Link>
        </div>
      )}
    </article>
  )
}

function StatusMessage({ title, message, error = false }: { title: string; message: string; error?: boolean }) {
  return (
    <section className={`status-message ${error ? 'is-error' : ''}`}>
      <strong>{title}</strong>
      <span>{message}</span>
    </section>
  )
}
