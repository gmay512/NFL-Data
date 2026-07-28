import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { hasSupabaseEnv, supabase } from '../lib/supabase'
import type { GameRow, LeagueSeasonRow, TeamRow } from '../types/nfl'

type AvailableSeason = {
  season: number
  current: boolean
}

type TeamMap = Record<number, TeamRow>

const UNASSIGNED_WEEK = '__unassigned__'

function getGameSortValue(game: GameRow) {
  if (game.game_timestamp != null) return game.game_timestamp

  if (game.game_date) {
    const parsed = Date.parse(game.game_date)
    if (Number.isFinite(parsed)) return parsed
  }

  return game.id
}

function getWeekKey(week: string | null) {
  return week?.trim() || UNASSIGNED_WEEK
}

function getWeekLabel(week: string | null) {
  return week?.trim() || 'Unassigned'
}

function formatGameDate(game: GameRow) {
  if (!game.game_date) return 'Date pending'

  const timePart = game.game_time ? ` ${game.game_time}` : ''
  return `${game.game_date}${timePart}`
}

function formatGameStatus(game: GameRow) {
  if (game.status_short === 'FT') return 'Final'
  if (game.status_short === 'NS') return 'Scheduled'
  if (game.status_short === 'PST') return 'Postponed'
  if (game.status_short === 'CANC') return 'Cancelled'
  if (game.status_short && game.status_short !== 'HT' && game.status_timer) {
    return `${game.status_short} ${game.status_timer}`
  }

  return game.status_long || game.status_short || 'Scheduled'
}

function renderScore(value: number | null) {
  return value == null ? '—' : String(value)
}

export function GamesPage() {
  const [seasons, setSeasons] = useState<AvailableSeason[]>([])
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [selectedSeason, setSelectedSeason] = useState('')
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0)
  const [games, setGames] = useState<GameRow[]>([])
  const [isLoadingMeta, setIsLoadingMeta] = useState(true)
  const [isLoadingGames, setIsLoadingGames] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadMeta = async () => {
      if (!supabase) {
        setIsLoadingMeta(false)
        return
      }

      setIsLoadingMeta(true)
      setError(null)

      const [seasonsResult, teamResult] = await Promise.all([
        supabase
          .from('league_seasons')
          .select('season_year, is_current')
          .order('season_year', { ascending: false }),
        supabase.from('teams').select('id, name, logo_url').order('id', { ascending: true }),
      ])

      const firstError = [seasonsResult, teamResult].find((result) => result.error)?.error
      if (firstError) {
        setError(firstError.message)
        setIsLoadingMeta(false)
        return
      }

      const seasonRows = (seasonsResult.data ?? []) as LeagueSeasonRow[]
      const normalizedSeasons: AvailableSeason[] = seasonRows
        .map((row) => ({ season: row.season_year, current: row.is_current }))
        .filter((row, index, allRows) => allRows.findIndex((candidate) => candidate.season === row.season) === index)

      if (normalizedSeasons.length === 0) {
        const gamesSeasonResult = await supabase
          .from('games')
          .select('season')
          .not('season', 'is', null)
          .order('season', { ascending: false })

        if (gamesSeasonResult.error) {
          setError(gamesSeasonResult.error.message)
          setIsLoadingMeta(false)
          return
        }

        const gameSeasons = Array.from(
          new Set((gamesSeasonResult.data ?? []).map((row) => row.season).filter((season): season is number => season != null)),
        )

        normalizedSeasons.push(...gameSeasons.map((season) => ({ season, current: false })))
      }

      setSeasons(normalizedSeasons)
      setTeams((teamResult.data ?? []) as TeamRow[])

      if (!selectedSeason && normalizedSeasons.length > 0) {
        const currentSeason = normalizedSeasons.find((row) => row.current) ?? normalizedSeasons[0]
        setSelectedSeason(String(currentSeason.season))
      }

      setIsLoadingMeta(false)
    }

    void loadMeta()
  }, [])

  useEffect(() => {
    const loadGames = async () => {
      if (!supabase || !selectedSeason) return

      setIsLoadingGames(true)
      setError(null)

      const { data, error: loadError } = await supabase
        .from('games')
        .select('*')
        .eq('season', Number(selectedSeason))

      if (loadError) {
        setError(loadError.message)
        setGames([])
        setIsLoadingGames(false)
        return
      }

      setGames((data ?? []) as GameRow[])
      setSelectedWeekIndex(0)
      setIsLoadingGames(false)
    }

    void loadGames()
  }, [selectedSeason])

  const teamMap = useMemo(() => Object.fromEntries(teams.map((team) => [team.id, team])) as TeamMap, [teams])

  const sortedGames = useMemo(
    () => [...games].sort((left, right) => getGameSortValue(left) - getGameSortValue(right)),
    [games],
  )

  const weekKeys = useMemo(() => {
    const seen = new Set<string>()
    const orderedWeeks: string[] = []

    for (const game of sortedGames) {
      const key = getWeekKey(game.week)
      if (seen.has(key)) continue
      seen.add(key)
      orderedWeeks.push(key)
    }

    return orderedWeeks
  }, [sortedGames])

  useEffect(() => {
    if (selectedWeekIndex >= weekKeys.length) {
      setSelectedWeekIndex(0)
    }
  }, [selectedWeekIndex, weekKeys.length])

  const currentWeekKey = weekKeys[selectedWeekIndex] ?? ''

  const weekGames = useMemo(
    () => sortedGames.filter((game) => getWeekKey(game.week) === currentWeekKey),
    [currentWeekKey, sortedGames],
  )

  const selectedSeasonMeta = seasons.find((season) => String(season.season) === selectedSeason)

  const canGoPreviousWeek = selectedWeekIndex > 0
  const canGoNextWeek = selectedWeekIndex < weekKeys.length - 1

  return (
    <main>
      <section className="hero games-hero">
        <p className="eyebrow">Games browser</p>
        <h1>Season and week-by-week game cards.</h1>
        <p className="hero-copy">
          Pick a season, step through the weeks, and open any game for a closer look.
        </p>

        <section className="panel games-controls-panel" aria-label="Games filters">
          <div className="games-controls-row">
            <label className="ingest-field games-season-field">
              <span>Season</span>
              <select
                value={selectedSeason}
                onChange={(event) => setSelectedSeason(event.target.value)}
                disabled={isLoadingMeta || seasons.length === 0}
              >
                <option value="">{isLoadingMeta ? 'Loading seasons...' : 'Select a season'}</option>
                {seasons.map((season) => (
                  <option key={season.season} value={season.season}>
                    {season.season}
                    {season.current ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <div className="week-nav" aria-label="Week navigation">
              <button
                type="button"
                className="week-nav-button"
                onClick={() => setSelectedWeekIndex((current) => Math.max(0, current - 1))}
                disabled={!canGoPreviousWeek}
              >
                Previous week
              </button>
              <div className="week-nav-current">
                <span>Week</span>
                <strong>{currentWeekKey ? getWeekLabel(currentWeekKey) : 'No week selected'}</strong>
              </div>
              <button
                type="button"
                className="week-nav-button"
                onClick={() => setSelectedWeekIndex((current) => Math.min(weekKeys.length - 1, current + 1))}
                disabled={!canGoNextWeek}
              >
                Next week
              </button>
            </div>
          </div>

          <div className="games-meta-row">
            <p>
              {selectedSeasonMeta ? (
                <>
                  Selected season: <strong>{selectedSeasonMeta.season}</strong>
                  {selectedSeasonMeta.current ? ' · current season' : ''}
                </>
              ) : (
                'Choose a season to load games.'
              )}
            </p>
            <p>
              {weekKeys.length > 0
                ? `${selectedWeekIndex + 1} of ${weekKeys.length} weeks`
                : 'No weeks loaded yet.'}
            </p>
          </div>
        </section>
      </section>

      {!hasSupabaseEnv && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Missing environment values</h2>
          <p>Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect this page.</p>
        </section>
      )}

      {error && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Games load error</h2>
          <p>{error}</p>
        </section>
      )}

      <section className="games-list-section" aria-label="Games list">
        <div className="panel panel-wide">
          <div className="section-heading">
            <p className="eyebrow">Week games</p>
            <h2>{currentWeekKey ? getWeekLabel(currentWeekKey) : 'Games for the selected week'}</h2>
          </div>

          {isLoadingMeta || isLoadingGames ? (
            <p className="table-status">Loading games...</p>
          ) : weekGames.length === 0 ? (
            <p className="table-status">No games found for this season and week.</p>
          ) : (
            <div className="games-grid">
              {weekGames.map((game) => {
                const homeTeam = game.home_team_id ? teamMap[game.home_team_id] : undefined
                const awayTeam = game.away_team_id ? teamMap[game.away_team_id] : undefined

                return (
                  <Link key={game.id} className="game-card" to={`/games/${game.id}`}>
                    <div className="game-card-top">
                      <div>
                        <p className="game-card-label">{game.stage || 'Game'}</p>
                        <h3>
                          {awayTeam?.name ?? `Away team ${game.away_team_id ?? ''}`}
                          {' @ '}
                          {homeTeam?.name ?? `Home team ${game.home_team_id ?? ''}`}
                        </h3>
                      </div>
                      <div className="game-card-status">{formatGameStatus(game)}</div>
                    </div>

                    <div className="scoreboard">
                      <div className="scoreboard-team">
                        <div className="team-mark">
                          {awayTeam?.logo_url ? <img src={awayTeam.logo_url} alt="" /> : <span>A</span>}
                        </div>
                        <div className="team-meta">
                          <strong>{awayTeam?.name ?? 'Away team'}</strong>
                          <span>Away</span>
                        </div>
                        <div className="team-score">{renderScore(game.away_total)}</div>
                      </div>

                      <div className="scoreboard-divider" />

                      <div className="scoreboard-team">
                        <div className="team-mark">
                          {homeTeam?.logo_url ? <img src={homeTeam.logo_url} alt="" /> : <span>H</span>}
                        </div>
                        <div className="team-meta">
                          <strong>{homeTeam?.name ?? 'Home team'}</strong>
                          <span>Home</span>
                        </div>
                        <div className="team-score">{renderScore(game.home_total)}</div>
                      </div>
                    </div>

                    <div className="game-card-footer">
                      <span>{formatGameDate(game)}</span>
                      <span>
                        {game.venue_name || game.venue_city
                          ? [game.venue_name, game.venue_city].filter(Boolean).join(', ')
                          : 'Venue pending'}
                      </span>
                    </div>
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