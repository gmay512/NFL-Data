import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { getAvailableSeasons, ingestSeason, refreshLiveGames as refreshLiveGamesFromApi, refreshSeasonGames } from '../api/app-api'
import {
  getDashboardMetadata,
  getGamesByIds,
  getSeasonGames,
  getTeamStatsForGames,
  getTeams,
  invalidateReferenceData,
} from '../data/nfl-repository'
import { ScheduleGameCard, StatusMessage } from '../features/dashboard/DashboardComponents'
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

      let metadata
      try {
        metadata = await getDashboardMetadata()
      } catch (metadataError) {
        setError(metadataError instanceof Error ? metadataError.message : 'Could not load dashboard metadata.')
        setIsLoading(false)
        return
      }

      const seasonRows = metadata.seasons as LeagueSeasonRow[]
      const localSeasons = seasonRows
        .map((row) => ({ season: row.season_year, current: row.is_current }))
        .filter((season, index, all) => all.findIndex((candidate) => candidate.season === season.season) === index)

      let apiSeasons: SeasonOption[] = []
      try {
        const payload = await getAvailableSeasons()
        apiSeasons = payload.seasons
      } catch {
        // Local season metadata remains available when the API is not configured.
      }

      const seasonsByYear = new Map(apiSeasons.map((season) => [season.season, season]))
      for (const season of localSeasons) {
        seasonsByYear.set(season.season, season)
      }
      const availableSeasons = Array.from(seasonsByYear.values()).sort((left, right) => right.season - left.season)

      setSeasons(availableSeasons)
      setTeams(metadata.teams)
      setSelectedSeason((current) => current || String((availableSeasons.find((season) => season.current) ?? availableSeasons[0])?.season ?? ''))
      setIsLoading(false)
    }

    void loadDashboardMeta()
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadSeasonGames = async () => {
      if (!supabase || !selectedSeason || (mode !== 'season' && mode !== 'team')) return
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

      const fetchGames = () => getSeasonGames(
        Number(selectedSeason),
        mode === 'team' && selectedTeamId ? Number(selectedTeamId) : undefined,
      )

      try {
        let loadedGames = await fetchGames()
        if (loadedGames.some((game) => shouldRefreshGame(game))) {
          try {
            await refreshSeasonGames(Number(selectedSeason))
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
          let statsData: GameTeamStatRow[]
          let statsError: unknown
          try {
            statsData = await getTeamStatsForGames(Number(selectedTeamId), loadedGames.map((game) => game.id))
          } catch (loadStatsError) {
            statsData = []
            statsError = loadStatsError
          }
          if (cancelled) return
          if (statsError) {
            setError(statsError instanceof Error ? statsError.message : 'Could not load team statistics.')
            setTeamGameStats({})
          } else {
            setTeamGameStats(
              Object.fromEntries(statsData.map((stats) => [stats.game_id, stats])),
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
  }, [mode, reloadKey, selectedSeason, selectedTeamId])

  const loadSeason = async () => {
    if (!supabase || !selectedSeason) return

    setIsIngestingSeason(true)
    setError(null)
    setLoadMessage(null)
    try {
      const payload = await ingestSeason(Number(selectedSeason))
      invalidateReferenceData()
      setTeams(await getTeams())
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
      const payload = await refreshLiveGamesFromApi()
      if (requestId !== liveRequestId.current) return

      const gameIds = payload.gameIds ?? []
      if (!gameIds.length) {
        setGames([])
        setSelectedWeek('')
        setLastLiveCheckedAt(new Date())
        return
      }

      const data = await getGamesByIds(gameIds)
      if (requestId !== liveRequestId.current) return

      setGames(data)
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
  const activeWeek = weeks.includes(selectedWeek) ? selectedWeek : (weeks[0] ?? '')

  useEffect(() => {
    const nextSearchParams = new URLSearchParams()
    if (selectedSeason) nextSearchParams.set('season', selectedSeason)
    if (mode === 'live') {
      nextSearchParams.set('view', 'live')
    } else if (mode === 'team') {
      nextSearchParams.set('view', 'team')
      if (selectedTeamId) nextSearchParams.set('team', selectedTeamId)
    } else if (activeWeek) {
      nextSearchParams.set('week', activeWeek)
    }

    if (nextSearchParams.toString() !== searchParams.toString()) {
      setSearchParams(nextSearchParams, { replace: true })
    }
  }, [activeWeek, mode, searchParams, selectedSeason, selectedTeamId, setSearchParams])

  const displayedGames = useMemo(
    () => (mode === 'season' ? games.filter((game) => getWeekKey(game) === activeWeek) : games),
    [activeWeek, games, mode],
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
                  <button key={week} className={`week-button ${activeWeek === week ? 'is-active' : ''}`} type="button" onClick={() => setSelectedWeek(week)}>
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
              <h2>{mode === 'live' ? 'In progress' : mode === 'team' ? `${selectedSeasonLabel ?? ''} season` : getWeekLabel(activeWeek || UNASSIGNED_WEEK)}</h2>
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
