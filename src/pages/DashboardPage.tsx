import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GameRow, LeagueSeasonRow, TeamRow } from '../types/nfl'

type DashboardMode = 'season' | 'live'
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

function getGameDate(game: GameRow) {
  if (!game.game_date) return 'Date pending'
  return game.game_time ? `${game.game_date} · ${game.game_time}` : game.game_date
}

function renderScore(score: number | null) {
  return score == null ? '—' : score
}

export function DashboardPage() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [seasons, setSeasons] = useState<SeasonOption[]>([])
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [selectedSeason, setSelectedSeason] = useState(() => searchParams.get('season') ?? '')
  const [selectedWeek, setSelectedWeek] = useState(() => searchParams.get('week') ?? '')
  const [games, setGames] = useState<GameRow[]>([])
  const [mode, setMode] = useState<DashboardMode>(() => (searchParams.get('view') === 'live' ? 'live' : 'season'))
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshingLive, setIsRefreshingLive] = useState(false)
  const [isIngestingSeason, setIsIngestingSeason] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [loadMessage, setLoadMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    const loadSeasonGames = async () => {
      if (!supabase || !selectedSeason || mode !== 'season') return

      setIsLoading(true)
      setError(null)
      const { data, error: gamesError } = await supabase
        .from('games')
        .select('*')
        .eq('season', Number(selectedSeason))
        .order('game_timestamp', { ascending: true })

      if (gamesError) {
        setError(gamesError.message)
        setGames([])
      } else {
        setGames((data ?? []) as GameRow[])
      }
      setIsLoading(false)
    }

    void loadSeasonGames()
  }, [mode, reloadKey, selectedSeason])

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

  const loadLiveGames = async () => {
    if (!supabase) return

    setMode('live')
    setIsRefreshingLive(true)
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/live-games', { method: 'POST' })
      const payload = (await response.json()) as { gameIds?: number[]; error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Could not refresh live games.')

      const gameIds = payload.gameIds ?? []
      if (!gameIds.length) {
        setGames([])
        setSelectedWeek('')
        return
      }

      const { data, error: gamesError } = await supabase.from('games').select('*').in('id', gameIds)
      if (gamesError) throw gamesError

      setGames((data ?? []) as GameRow[])
      setSelectedWeek('')
    } catch (liveError) {
      setError(liveError instanceof Error ? liveError.message : 'Could not refresh live games.')
      setGames([])
    } finally {
      setIsLoading(false)
      setIsRefreshingLive(false)
    }
  }

  const teamById = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team])) as Record<number, TeamRow>, [teams])
  const weeks = useMemo(() => Array.from(new Set(games.map(getWeekKey))), [games])

  useEffect(() => {
    if (mode !== 'season') return
    setSelectedWeek((week) => (weeks.includes(week) ? week : (weeks[0] ?? '')))
  }, [mode, weeks])

  useEffect(() => {
    const nextSearchParams = new URLSearchParams()
    if (selectedSeason) nextSearchParams.set('season', selectedSeason)
    if (mode === 'live') {
      nextSearchParams.set('view', 'live')
    } else if (selectedWeek) {
      nextSearchParams.set('week', selectedWeek)
    }

    if (nextSearchParams.toString() !== searchParams.toString()) {
      setSearchParams(nextSearchParams, { replace: true })
    }
  }, [mode, searchParams, selectedSeason, selectedWeek, setSearchParams])

  const displayedGames = useMemo(
    () => (mode === 'live' ? games : games.filter((game) => getWeekKey(game) === selectedWeek)),
    [games, mode, selectedWeek],
  )
  const selectedSeasonLabel = seasons.find((season) => String(season.season) === selectedSeason)?.season

  return (
    <main className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">NFL game center</p>
          <h1>Every week, every matchup.</h1>
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
          <button className={`live-button ${mode === 'live' ? 'is-active' : ''}`} type="button" onClick={() => void loadLiveGames()} disabled={isRefreshingLive}>
            <span className="live-indicator" />
            {isRefreshingLive ? 'Checking live games' : 'Live games'}
          </button>
        </div>
      </section>

      {!hasSupabaseEnv && <StatusMessage title="Database connection required" message="Set the VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY variables to load game data." />}
      {error && <StatusMessage title="Unable to load games" message={error} error />}
      {loadMessage && <StatusMessage title="Season loaded" message={loadMessage} />}

      <section className="schedule-shell" aria-label="Game schedule">
        <aside className="week-sidebar">
          <div className="sidebar-heading">
            <p className="eyebrow">{mode === 'live' ? 'Now playing' : 'Season schedule'}</p>
            <h2>{mode === 'live' ? 'Live games' : selectedSeasonLabel ?? 'Select a season'}</h2>
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
          ) : (
            <p className="sidebar-note">Scores refresh from API-Sports whenever you select this view.</p>
          )}
        </aside>

        <div className="games-panel">
          <div className="games-panel-header">
            <div>
              <p className="eyebrow">{mode === 'live' ? 'Live scoreboard' : 'Games'}</p>
              <h2>{mode === 'live' ? 'In progress' : getWeekLabel(selectedWeek || UNASSIGNED_WEEK)}</h2>
            </div>
            <span>{displayedGames.length} {displayedGames.length === 1 ? 'game' : 'games'}</span>
          </div>

          {isLoading ? (
            <p className="empty-state">Loading games…</p>
          ) : displayedGames.length === 0 ? (
            mode === 'live' ? (
              <p className="empty-state">There are no live NFL games right now.</p>
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
                return (
                  <Link
                    className="schedule-game"
                    key={game.id}
                    to={`/games/${game.id}`}
                    state={{ dashboardPath: `${location.pathname}${location.search}` }}
                  >
                    <div className="schedule-game-meta">
                      <span>{getGameStatus(game)}</span>
                      <time>{getGameDate(game)}</time>
                    </div>
                    <div className="schedule-team">
                      <TeamMark team={awayTeam} fallback="A" />
                      <strong>{awayTeam?.name ?? `Away team ${game.away_team_id ?? ''}`}</strong>
                      <b>{renderScore(game.away_total)}</b>
                    </div>
                    <div className="schedule-team">
                      <TeamMark team={homeTeam} fallback="H" />
                      <strong>{homeTeam?.name ?? `Home team ${game.home_team_id ?? ''}`}</strong>
                      <b>{renderScore(game.home_total)}</b>
                    </div>
                    <span className="game-chevron" aria-hidden="true">›</span>
                  </Link>
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

function StatusMessage({ title, message, error = false }: { title: string; message: string; error?: boolean }) {
  return (
    <section className={`status-message ${error ? 'is-error' : ''}`}>
      <strong>{title}</strong>
      <span>{message}</span>
    </section>
  )
}
