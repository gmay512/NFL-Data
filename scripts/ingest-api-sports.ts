import { createClient } from '@supabase/supabase-js'

type Dict = Record<string, unknown>

type EndpointResponse<T> = {
  response: T[]
}

function readCliArg(name: string): string | null {
  const prefix = `--${name}=`
  const match = process.argv.find((arg: string) => arg.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

function parseSeasonArg(): number | null {
  const raw = readCliArg('season')
  if (raw == null) return null

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 3000) {
    throw new Error(`Invalid --season value: ${raw}. Expected a 4-digit year like 2024.`)
  }

  return parsed
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const apiBaseUrl = process.env.API_SPORTS_BASE_URL ?? 'https://v1.american-football.api-sports.io'
const apiKey = process.env.API_SPORTS_KEY
const apiHost = process.env.API_SPORTS_HOST ?? 'v1.american-football.api-sports.io'
const season = parseSeasonArg() ?? Number(process.env.API_SPORTS_SEASON ?? '2023')
const leagueId = Number(process.env.API_SPORTS_LEAGUE_ID ?? '1')

if (!supabaseUrl || !serviceRoleKey || !apiKey) {
  throw new Error(
    'Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_SPORTS_KEY',
  )
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
})

const apiHeaders = {
  'x-apisports-key': apiKey,
  'x-rapidapi-key': apiKey,
  'x-rapidapi-host': apiHost,
}

async function fetchEndpoint<T>(path: string, params: Record<string, string | number>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => search.set(key, String(value)))
  const url = `${apiBaseUrl}${path}?${search.toString()}`

  const result = await fetch(url, { headers: apiHeaders })
  if (!result.ok) {
    const body = await result.text()
    throw new Error(`API request failed (${result.status}) ${url}\n${body}`)
  }

  return (await result.json()) as EndpointResponse<T>
}

async function fetchEndpointWithRetry<T>(
  path: string,
  params: Record<string, string | number>,
  maxRetries = 5,
) {
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetchEndpoint<T>(path, params)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const isRateLimit = message.includes('(429)') || message.toLowerCase().includes('ratelimit')

      if (!isRateLimit || attempt === maxRetries) {
        throw error
      }

      const backoffMs = Math.min(8000, 500 * 2 ** attempt)
      console.warn(`Rate limited on ${path}. Retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw lastError
}

function toInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const asNumber = Number(value)
  return Number.isFinite(asNumber) ? asNumber : null
}

function asString(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text.length ? text : null
}

function asDict(value: unknown): Dict {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Dict
  }

  return {}
}

function pickFromDict(source: Dict, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value != null && value !== '') return value
  }

  return null
}

function pickInt(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toInt(value)
    if (parsed != null) return parsed
  }

  return null
}

function pickText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue
    }

    const text = String(value).trim()
    if (text.length) return text
  }

  return null
}

function flattenStatsBlock(block: Dict | undefined): Array<{ stat_group: string; stat_name: string; stat_value: string | null }> {
  if (!block) return []

  const output: Array<{ stat_group: string; stat_name: string; stat_value: string | null }> = []
  for (const [group, value] of Object.entries(block)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [statName, statValue] of Object.entries(value as Dict)) {
        output.push({
          stat_group: group,
          stat_name: statName,
          stat_value: asString(statValue),
        })
      }
    } else {
      output.push({
        stat_group: 'summary',
        stat_name: group,
        stat_value: asString(value),
      })
    }
  }

  return output
}

async function upsertLeaguesAndSeasons() {
  type LeagueApi = {
    league?: Dict
    country?: Dict
    seasons?: Dict[]
  }

  const payload = await fetchEndpoint<LeagueApi>('/leagues', {})
  const leagues: Dict[] = []
  const seasons: Dict[] = []

  for (const item of payload.response) {
    const league = item.league ?? {}
    const country = item.country ?? {}

    const leagueIdValue = toInt(league.id)
    if (!leagueIdValue) continue

    leagues.push({
      id: leagueIdValue,
      name: asString(league.name) ?? `League ${leagueIdValue}`,
      logo_url: asString(league.logo),
      country_name: asString(country.name),
      country_code: asString(country.code),
      country_flag_url: asString(country.flag),
    })

    for (const seasonItem of item.seasons ?? []) {
      const coverage = (seasonItem.coverage as Dict | undefined) ?? {}
      const coverageGames = (coverage.games as Dict | undefined) ?? {}
      const coveragePlayers = (coverage.players as Dict | undefined) ?? {}

      seasons.push({
        league_id: leagueIdValue,
        season_year: toInt(seasonItem.year),
        start_date: asString(seasonItem.start),
        end_date: asString(seasonItem.end),
        is_current: Boolean(seasonItem.current),
        cov_games_events: coverageGames.events === true,
        cov_stats_teams: coverageGames.statistics_teams === true,
        cov_stats_players: coverageGames.statistics_players === true,
        cov_season_players: coveragePlayers.statistics === true,
        cov_players: coveragePlayers.players === true,
        cov_injuries: coverage.injuries === true,
        cov_standings: coverage.standings === true,
      })
    }
  }

  if (leagues.length) {
    const { error } = await supabase.from('leagues').upsert(leagues, { onConflict: 'id' })
    if (error) throw error
  }

  if (seasons.length) {
    const normalizedSeasons = seasons.filter((row) => row.season_year != null)
    const { error } = await supabase
      .from('league_seasons')
      .upsert(normalizedSeasons, { onConflict: 'league_id,season_year' })
    if (error) throw error
  }

  console.log(`Upserted leagues=${leagues.length}, league_seasons=${seasons.length}`)
}

async function upsertGames() {
  type GameApi = {
    game?: Dict
    league?: Dict
    teams?: Dict
    scores?: Dict
  }

  const payload = await fetchEndpoint<GameApi>('/games', {
    league: leagueId,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const game = item.game ?? {}
      const teams = item.teams ?? {}
      const venue = game.venue as Dict | undefined
      const scores = (item.scores ?? (game.scores as Dict | undefined) ?? {}) as Dict
      const homeScores = (scores.home ?? {}) as Dict
      const awayScores = (scores.away ?? {}) as Dict
      const gameId = toInt(game.id)
      if (!gameId) return null

      const homeTeamId = toInt((teams.home as Dict | undefined)?.id)
      const awayTeamId = toInt((teams.away as Dict | undefined)?.id)
      if (!homeTeamId || !awayTeamId) return null

      return {
        id: gameId,
        league_id: toInt(item.league?.id) ?? leagueId,
        season,
        stage: pickText(game.stage),
        week: pickText(game.week),
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        date_timezone: pickText(game.timezone, game.date_timezone),
        game_date: pickText(game.date, (game.date as Dict | undefined)?.date),
        game_time: pickText(game.time, (game.time as Dict | undefined)?.time),
        game_timestamp: toInt(game.timestamp),
        venue_name: pickText(venue?.name),
        venue_city: pickText(venue?.city),
        status_short: pickText((game.status as Dict | undefined)?.short),
        status_long: pickText((game.status as Dict | undefined)?.long),
        status_timer: pickText((game.status as Dict | undefined)?.timer),
        home_q1: toInt(homeScores.q1 ?? homeScores.quarter_1 ?? homeScores.quarter1),
        home_q2: toInt(homeScores.q2 ?? homeScores.quarter_2 ?? homeScores.quarter2),
        home_q3: toInt(homeScores.q3 ?? homeScores.quarter_3 ?? homeScores.quarter3),
        home_q4: toInt(homeScores.q4 ?? homeScores.quarter_4 ?? homeScores.quarter4),
        home_ot: toInt(homeScores.ot ?? homeScores.overtime),
        home_total: toInt(homeScores.total),
        away_q1: toInt(awayScores.q1 ?? awayScores.quarter_1 ?? awayScores.quarter1),
        away_q2: toInt(awayScores.q2 ?? awayScores.quarter_2 ?? awayScores.quarter2),
        away_q3: toInt(awayScores.q3 ?? awayScores.quarter_3 ?? awayScores.quarter3),
        away_q4: toInt(awayScores.q4 ?? awayScores.quarter_4 ?? awayScores.quarter4),
        away_ot: toInt(awayScores.ot ?? awayScores.overtime),
        away_total: toInt(awayScores.total),
        venue: pickText(venue?.name, venue?.city),
      }
    })
    .filter(Boolean) as Dict[]

  if (!rows.length) {
    console.log('No game rows returned.')
    return
  }

  const { error } = await supabase.from('games').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  console.log(`Upserted games=${rows.length}`)
}

async function upsertInjuries() {
  type InjuryApi = {
    player?: Dict
    team?: Dict
    injury?: Dict
  }

  const payload = await fetchEndpoint<InjuryApi>('/injuries', {
    league: leagueId,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const playerId = toInt(item.player?.id)
      if (!playerId) return null

      return {
        player_id: playerId,
        team_id: toInt(item.team?.id),
        injury_date: asString(item.injury?.date),
        status: asString(item.injury?.status),
        description: asString(item.injury?.description),
      }
    })
    .filter(Boolean) as Dict[]

  if (!rows.length) {
    console.log('No injury rows returned.')
    return
  }

  const { error } = await supabase.from('injuries').upsert(rows, { onConflict: 'player_id' })
  if (error) throw error
  console.log(`Upserted injuries=${rows.length}`)
}

async function upsertPlayerSeasonStats() {
  type PlayerStatsApi = {
    player?: Dict
    team?: Dict
    statistics?: Dict[]
  }

  const payload = await fetchEndpoint<PlayerStatsApi>('/players/statistics', {
    league: leagueId,
    season,
  })

  const rows: Dict[] = []

  for (const item of payload.response) {
    const playerId = toInt(item.player?.id)
    const teamId = toInt(item.team?.id)
    if (!playerId || !teamId) continue

    const statsBlocks = item.statistics ?? []
    for (const block of statsBlocks) {
      for (const entry of flattenStatsBlock(block)) {
        rows.push({
          player_id: playerId,
          team_id: teamId,
          season,
          stat_group: entry.stat_group,
          stat_name: entry.stat_name,
          stat_value: entry.stat_value,
        })
      }
    }
  }

  if (!rows.length) {
    console.log('No player season stat rows returned.')
    return
  }

  const { error } = await supabase
    .from('player_season_stats')
    .upsert(rows, { onConflict: 'player_id,team_id,season,stat_group,stat_name' })
  if (error) throw error
  console.log(`Upserted player_season_stats=${rows.length}`)
}

async function upsertStandings() {
  type StandingApi = {
    league?: Dict
    team?: Dict
    conference?: Dict
    division?: Dict
    position?: string | number
    won?: Dict
    lost?: Dict
    ties?: Dict
    points?: Dict
    streak?: string
  }

  const payload = await fetchEndpoint<StandingApi>('/standings', {
    league: leagueId,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const leagueValue = toInt(item.league?.id)
      const teamValue = toInt(item.team?.id)
      if (!leagueValue || !teamValue) return null

      return {
        league_id: leagueValue,
        season: toInt(item.league?.season) ?? season,
        team_id: teamValue,
        conference: asString(item.conference?.name),
        division: asString(item.division?.name),
        position: toInt(item.position),
        won: toInt(item.won?.total) ?? 0,
        lost: toInt(item.lost?.total) ?? 0,
        ties: toInt(item.ties?.total) ?? 0,
        points_for: toInt(item.points?.for),
        points_against: toInt(item.points?.against),
        points_diff: toInt(item.points?.difference),
        record_home: asString(item.won?.home),
        record_road: asString(item.won?.away),
        record_conference: asString(item.won?.conference),
        record_division: asString(item.won?.division),
        streak: asString(item.streak),
      }
    })
    .filter(Boolean) as Dict[]

  if (!rows.length) {
    console.log('No standings rows returned.')
    return
  }

  const { error } = await supabase
    .from('standings')
    .upsert(rows, { onConflict: 'league_id,season,team_id' })
  if (error) throw error
  console.log(`Upserted standings=${rows.length}`)
}

async function upsertGameTeamStats() {
  type GameTeamStatsApi = {
    id?: unknown
    game?: Dict
    team?: Dict
    game_id?: unknown
    gameId?: unknown
    team_id?: unknown
    teamId?: unknown
    statistics?: Dict | Dict[]
  }
  type GameTeamStatsUpsertRow = {
    game_id: number
    team_id: number
    fd_total: number | null
    fd_passing: number | null
    fd_rushing: number | null
    fd_penalties: number | null
    third_down_eff: string | null
    fourth_down_eff: string | null
    plays_total: number | null
    yards_total: number | null
    yards_per_play: string | null
    total_drives: string | null
    pass_yards: number | null
    pass_comp_att: string | null
    pass_yards_per: string | null
    pass_int: number | null
    sacks_yards_lost: string | null
    rush_yards: number | null
    rush_attempts: number | null
    rush_yards_per: string | null
    red_zone: string | null
    penalties: string | null
    turnovers_total: number | null
    fumbles_lost: number | null
    int_turnovers: number | null
    possession: string | null
    def_interceptions: number | null
    fumbles_recovered: number | null
    sacks: number | null
    safeties: number | null
    int_touchdowns: number | null
    points_against: number | null
  }

  const payload = await fetchEndpoint<GameTeamStatsApi>('/games/statistics/teams', {
    league: leagueId,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const gameId = pickInt(item.game?.id, item.game_id, item.gameId, item.id)
      const teamId = pickInt(item.team?.id, item.team_id, item.teamId)
      if (!gameId || !teamId) return null

      const stats = asDict(item.statistics)
      const firstDowns = asDict(pickFromDict(stats, 'first_downs'))
      const plays = asDict(pickFromDict(stats, 'plays'))
      const yards = asDict(pickFromDict(stats, 'yards'))
      const passing = asDict(pickFromDict(stats, 'passing'))
      const rushings = asDict(pickFromDict(stats, 'rushings', 'rushing'))
      const redZone = asDict(pickFromDict(stats, 'red_zone'))
      const penalties = asDict(pickFromDict(stats, 'penalties'))
      const turnovers = asDict(pickFromDict(stats, 'turnovers'))
      const posession = asDict(pickFromDict(stats, 'posession'))
      const possession = asDict(pickFromDict(stats, 'possession'))
      const interceptions = asDict(pickFromDict(stats, 'interceptions'))
      const fumblesRecovered = asDict(pickFromDict(stats, 'fumbles_recovered'))
      const sacks = asDict(pickFromDict(stats, 'sacks'))
      const safeties = asDict(pickFromDict(stats, 'safeties'))
      const intTouchdowns = asDict(pickFromDict(stats, 'int_touchdowns'))
      const pointsAgainst = asDict(pickFromDict(stats, 'points_against'))

      return {
        game_id: gameId,
        team_id: teamId,
        fd_total: pickInt(pickFromDict(firstDowns, 'total'), pickFromDict(stats, 'first_downs_total')),
        fd_passing: pickInt(pickFromDict(firstDowns, 'passing'), pickFromDict(stats, 'first_downs_passing')),
        fd_rushing: pickInt(pickFromDict(firstDowns, 'rushing'), pickFromDict(stats, 'first_downs_rushing')),
        fd_penalties: pickInt(pickFromDict(firstDowns, 'from_penalties'), pickFromDict(stats, 'first_downs_from_penalties')),
        third_down_eff: pickText(pickFromDict(firstDowns, 'third_down_efficiency'), pickFromDict(stats, 'third_down_efficiency')),
        fourth_down_eff: pickText(pickFromDict(firstDowns, 'fourth_down_efficiency'), pickFromDict(stats, 'fourth_down_efficiency')),
        plays_total: pickInt(pickFromDict(plays, 'total'), pickFromDict(stats, 'total_plays')),
        yards_total: pickInt(pickFromDict(yards, 'total'), pickFromDict(stats, 'total_yards')),
        yards_per_play: pickText(pickFromDict(yards, 'yards_per_play'), pickFromDict(stats, 'yards_per_play')),
        total_drives: pickText(pickFromDict(yards, 'total_drives'), pickFromDict(stats, 'total_drives')),
        pass_yards: pickInt(pickFromDict(passing, 'total'), pickFromDict(stats, 'passing_yards')),
        pass_comp_att: pickText(pickFromDict(passing, 'comp_att'), pickFromDict(stats, 'completions_attempts')),
        pass_yards_per: pickText(pickFromDict(passing, 'yards_per_pass'), pickFromDict(stats, 'yards_per_pass')),
        pass_int: pickInt(pickFromDict(passing, 'interceptions_thrown'), pickFromDict(stats, 'interceptions_thrown')),
        sacks_yards_lost: pickText(pickFromDict(passing, 'sacks_yards_lost'), pickFromDict(stats, 'sacks_yards_lost')),
        rush_yards: pickInt(pickFromDict(rushings, 'total'), pickFromDict(stats, 'rushing_yards')),
        rush_attempts: pickInt(pickFromDict(rushings, 'attempts'), pickFromDict(stats, 'rushing_attempts')),
        rush_yards_per: pickText(pickFromDict(rushings, 'yards_per_rush'), pickFromDict(stats, 'yards_per_rush')),
        red_zone: pickText(pickFromDict(redZone, 'made_att'), pickFromDict(stats, 'red_zone_efficiency')),
        penalties: pickText(pickFromDict(penalties, 'total'), pickFromDict(stats, 'penalties')),
        turnovers_total: pickInt(pickFromDict(turnovers, 'total'), pickFromDict(stats, 'turnovers')),
        fumbles_lost: pickInt(pickFromDict(turnovers, 'lost_fumbles'), pickFromDict(stats, 'fumbles_lost')),
        int_turnovers: pickInt(pickFromDict(turnovers, 'interceptions'), pickFromDict(stats, 'interceptions')),
        possession: pickText(
          pickFromDict(posession, 'total'),
          pickFromDict(possession, 'total'),
          pickFromDict(stats, 'posession'),
          pickFromDict(stats, 'possession'),
        ),
        def_interceptions: pickInt(pickFromDict(interceptions, 'total'), pickFromDict(stats, 'interceptions_defensively')),
        fumbles_recovered: pickInt(pickFromDict(fumblesRecovered, 'total'), pickFromDict(stats, 'fumbles_recovered')),
        sacks: pickInt(pickFromDict(sacks, 'total'), pickFromDict(stats, 'sacks')),
        safeties: pickInt(pickFromDict(safeties, 'total'), pickFromDict(stats, 'safeties')),
        int_touchdowns: pickInt(pickFromDict(intTouchdowns, 'total'), pickFromDict(stats, 'interception_touchdowns')),
        points_against: pickInt(pickFromDict(pointsAgainst, 'total'), pickFromDict(stats, 'points_allowed')),
      } satisfies GameTeamStatsUpsertRow
    })
    .filter(Boolean) as GameTeamStatsUpsertRow[]

  if (!rows.length) {
    console.log('No game team stat rows returned.')
    return
  }

  const { error } = await supabase.from('game_team_stats').upsert(rows, { onConflict: 'game_id,team_id' })
  if (error) throw error
  console.log(`Upserted game_team_stats=${rows.length}`)
}

async function upsertGamePlayerStats() {
  type GamePlayerStatsApi = {
    game?: Dict
    team?: Dict
    player?: Dict
    statistics?: Dict[]
  }

  const payload = await fetchEndpoint<GamePlayerStatsApi>('/games/statistics/players', {
    league: leagueId,
    season,
  })

  const rows: Dict[] = []

  for (const item of payload.response) {
    const gameId = toInt(item.game?.id)
    const teamId = toInt(item.team?.id)
    const playerId = toInt(item.player?.id)
    if (!gameId || !teamId || !playerId) continue

    for (const statsBlock of item.statistics ?? []) {
      for (const entry of flattenStatsBlock(statsBlock)) {
        rows.push({
          game_id: gameId,
          team_id: teamId,
          player_id: playerId,
          stat_group: entry.stat_group,
          stat_name: entry.stat_name,
          stat_value: entry.stat_value,
        })
      }
    }
  }

  if (!rows.length) {
    console.log('No game player stat rows returned.')
    return
  }

  const { error } = await supabase
    .from('game_player_stats')
    .upsert(rows, { onConflict: 'game_id,team_id,player_id,stat_group,stat_name' })
  if (error) throw error
  console.log(`Upserted game_player_stats=${rows.length}`)
}

async function upsertTeams() {
  type TeamApi = {
    id?: unknown
    name?: unknown
    code?: unknown
    city?: unknown
    coach?: unknown
    owner?: unknown
    stadium?: unknown
    established?: unknown
    logo?: unknown
    country?: { name?: unknown; code?: unknown; flag?: unknown }
  }

  const payload = await fetchEndpoint<TeamApi>('/teams', {
    league: leagueId,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const id = toInt(item.id)
      if (!id) return null

      return {
        id,
        name: asString(item.name) ?? `Team ${id}`,
        code: asString(item.code),
        city: asString(item.city),
        coach: asString(item.coach),
        owner: asString(item.owner),
        stadium: asString(item.stadium),
        established: toInt(item.established),
        logo_url: asString(item.logo),
        country_name: asString(item.country?.name),
        country_code: asString(item.country?.code),
        country_flag_url: asString(item.country?.flag),
      }
    })
    .filter(Boolean) as Dict[]

  if (!rows.length) {
    console.log('No team rows returned.')
    return
  }

  const { error } = await supabase.from('teams').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  console.log(`Upserted teams=${rows.length}`)
}

async function upsertPlayers() {
  type TeamApi = { id?: unknown }
  type PlayerApi = {
    id?: unknown
    name?: unknown
    age?: unknown
    height?: unknown
    weight?: unknown
    college?: unknown
    group?: unknown
    position?: unknown
    number?: unknown
    salary?: unknown
    experience?: unknown
    image?: unknown
  }

  const teamsPayload = await fetchEndpoint<TeamApi>('/teams', {
    league: leagueId,
    season,
  })

  const teamIds = teamsPayload.response
    .map((team) => toInt(team.id))
    .filter((id): id is number => Boolean(id))

  const playersById = new Map<number, Dict>()

  for (const teamId of teamIds) {
    const payload = await fetchEndpoint<PlayerApi>('/players', {
      season,
      team: teamId,
    })

    for (const item of payload.response) {
      const id = toInt(item.id)
      if (!id) continue

      playersById.set(id, {
        id,
        name: asString(item.name) ?? `Player ${id}`,
        age: toInt(item.age),
        height: asString(item.height),
        weight: asString(item.weight),
        college: asString(item.college),
        position_group: asString(item.group),
        position: asString(item.position),
        jersey_number: toInt(item.number),
        salary_bracket: asString(item.salary),
        experience_years: toInt(item.experience),
        image_url: asString(item.image),
      })
    }
  }

  const rows = Array.from(playersById.values())

  if (!rows.length) {
    console.log('No player rows returned.')
    return
  }

  const { error } = await supabase.from('players').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  console.log(`Upserted players=${rows.length} from ${teamIds.length} teams`)
}

async function upsertGameEvents() {
  type GameEventsApi = {
    game?: Dict
    team?: Dict
    player?: Dict
    quarter?: unknown
    time?: unknown
    type?: unknown
    comment?: unknown
    scores?: { home?: { total?: unknown }; away?: { total?: unknown } }
  }

  // Fetch all non-scheduled game IDs for the season from the DB
  const { data: gameRows, error: fetchError } = await supabase
    .from('games')
    .select('id')
    .eq('season', season)
    .neq('status_short', 'NS')
  if (fetchError) throw fetchError

  const gameIds = (gameRows ?? []).map((row: { id: number }) => row.id)

  if (!gameIds.length) {
    console.log('No completed games found, skipping game events.')
    return
  }

  const CONCURRENCY = 2
  let totalRows = 0

  for (let i = 0; i < gameIds.length; i += CONCURRENCY) {
    const batch = gameIds.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (gameId: number) => {
        const payload = await fetchEndpointWithRetry<GameEventsApi>('/games/events', { id: gameId })
        const rows = payload.response
          .map((item) => {
            const teamId = toInt(item.team?.id)
            if (!teamId) return null
            return {
              game_id: gameId,
              team_id: teamId,
              player_id: toInt(item.player?.id),
              quarter: asString(item.quarter),
              minute: asString(item.time),
              event_type: asString(item.type),
              comment: asString(item.comment),
              score_home: toInt(item.scores?.home?.total),
              score_away: toInt(item.scores?.away?.total),
            }
          })
          .filter(Boolean) as Dict[]

        if (!rows.length) return

        const { error: delError } = await supabase
          .from('game_events')
          .delete()
          .eq('game_id', gameId)
        if (delError) throw delError

        const { error: insError } = await supabase.from('game_events').insert(rows)
        if (insError) throw insError

        totalRows += rows.length
      }),
    )
  }

  console.log(`Upserted game_events=${totalRows} across ${gameIds.length} games`)
}

async function upsertBookmakers() {
  type BookmakerApi = { id?: unknown; name?: unknown }
  const payload = await fetchEndpoint<BookmakerApi>('/odds/bookmakers', {})

  const rows = payload.response
    .map((item) => {
      const id = toInt(item.id)
      if (!id) return null
      return { id, name: asString(item.name) ?? `Bookmaker ${id}` }
    })
    .filter(Boolean) as Dict[]

  if (!rows.length) {
    console.log('No bookmaker rows returned.')
    return
  }

  const { error } = await supabase.from('bookmakers').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  console.log(`Upserted bookmakers=${rows.length}`)
}

async function upsertBetTypes() {
  type BetTypeApi = { id?: unknown; name?: unknown }
  const payload = await fetchEndpoint<BetTypeApi>('/odds/bets', {})

  const byName = new Map<string, { id: number; name: string }>()
  for (const item of payload.response) {
    const id = toInt(item.id)
    if (!id) continue
    const name = asString(item.name) ?? `Bet ${id}`

    // API can return duplicate names with different IDs; keep first seen to satisfy unique(name).
    if (!byName.has(name)) {
      byName.set(name, { id, name })
    }
  }

  const rows = Array.from(byName.values())

  if (!rows.length) {
    console.log('No bet type rows returned.')
    return
  }

  const { error } = await supabase.from('bet_types').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  console.log(`Upserted bet_types=${rows.length}`)
}

async function upsertOdds() {
  type OddsApi = {
    game?: Dict
    bookmakers?: Array<{
      id?: unknown
      bets?: Array<{
        id?: unknown
        values?: Array<{ value?: unknown; odd?: unknown }>
      }>
    }>
  }

  const payload = await fetchEndpoint<OddsApi>('/odds', {
    league: leagueId,
    season,
  })

  const gameIds = new Set<number>()
  const rows: Dict[] = []

  for (const item of payload.response) {
    const gameId = toInt(item.game?.id)
    if (!gameId) continue
    gameIds.add(gameId)

    for (const bookmaker of item.bookmakers ?? []) {
      const bookmakerId = toInt(bookmaker.id)
      if (!bookmakerId) continue

      for (const bet of bookmaker.bets ?? []) {
        const betId = toInt(bet.id)
        if (!betId) continue

        for (const val of bet.values ?? []) {
          const betValue = asString(val.value)
          if (!betValue) continue
          rows.push({
            game_id: gameId,
            bookmaker_id: bookmakerId,
            bet_id: betId,
            bet_value: betValue,
            odd: val.odd != null ? Number(val.odd) || null : null,
          })
        }
      }
    }
  }

  if (!rows.length) {
    console.log('No odds rows returned.')
    return
  }

  for (const gameId of gameIds) {
    const { error: delError } = await supabase.from('odds').delete().eq('game_id', gameId)
    if (delError) throw delError
  }

  const { error } = await supabase.from('odds').insert(rows)
  if (error) throw error
  console.log(`Upserted odds=${rows.length} for ${gameIds.size} games`)
}

async function run() {
  console.log(`Starting ingest for league=${leagueId} season=${season}...`)
  await upsertTeams()
  await upsertPlayers()
  await upsertBookmakers()
  await upsertBetTypes()
  await upsertLeaguesAndSeasons()
  await upsertGames()
  await upsertGameEvents()
  await upsertInjuries()
  await upsertPlayerSeasonStats()
  await upsertStandings()
  await upsertGameTeamStats()
  await upsertGamePlayerStats()
  await upsertOdds()
  console.log('Ingest completed.')
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
