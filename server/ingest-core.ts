import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type Dict = Record<string, unknown>

type EndpointResponse<T> = {
  response: T[]
}

type GameTeamStatsApi = Dict & { game?: Dict; team?: Dict; statistics?: Dict | Dict[] }

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

export type IngestConfig = {
  supabaseUrl?: string
  serviceRoleKey?: string
  apiKey: string
  apiBaseUrl?: string
  apiHost?: string
  leagueId?: number
}

export type IngestSummary = {
  season: number
  leagues: number
  leagueSeasons: number
  teams: number
  players: number
  games: number
  gameEvents: number
  injuries: number
  playerSeasonStats: number
  standings: number
  gameTeamStats: number
  gamePlayerStats: number
  bookmakers: number
  betTypes: number
  odds: number
}

export type AvailableSeason = {
  season: number
  current: boolean
  startDate: string | null
  endDate: string | null
}

type LiveGameApi = {
  game?: Dict
  league?: Dict
  teams?: Dict
  scores?: Dict
}

type GamePlayerStatsApi = {
  game?: Dict
  team?: Dict
  groups?: Array<{
    name?: unknown
    players?: Array<{
      player?: Dict
      statistics?: Array<{ name?: unknown; value?: unknown }>
    }>
  }>
}

type GamePlayerStatUpsertRow = {
  game_id: number
  team_id: number
  player_id: number
  stat_group: string
  stat_name: string
  stat_value: string | null
}

const defaultApiBaseUrl = 'https://v1.american-football.api-sports.io'
const defaultApiHost = 'v1.american-football.api-sports.io'
const scheduleTimezone = 'America/New_York'

function toInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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

function getGameDateFields(game: Dict) {
  const date = asDict(game.date)

  return {
    date_timezone: pickText(date.timezone, game.timezone, game.date_timezone),
    game_date: pickText(date.date, game.date),
    game_time: pickText(date.time, game.time),
    game_timestamp: pickInt(date.timestamp, game.timestamp),
  }
}

function mapGameTeamStatsItem(item: GameTeamStatsApi, fallbackGameId?: number): GameTeamStatsUpsertRow | null {
  const gameId = pickInt(
    item.game?.id,
    item.game_id,
    item.gameId,
    item.id,
    fallbackGameId,
  )
  const teamId = pickInt(item.team?.id, item.team_id, item.teamId)
  const stats = asDict(item.statistics)
  if (!gameId || !teamId) return null

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
  }
}

function mapGamePlayerStats(payload: EndpointResponse<GamePlayerStatsApi>, fallbackGameId?: number) {
  const players = new Map<number, { id: number; name: string; image_url: string | null }>()
  const rows: GamePlayerStatUpsertRow[] = []

  for (const gameItem of payload.response) {
    const gameId = toInt(gameItem.game?.id) ?? fallbackGameId
    const teamId = toInt(gameItem.team?.id)
    if (!gameId || !teamId) continue

    for (const groupEntry of gameItem.groups ?? []) {
      const statGroup = asString(groupEntry.name)
      if (!statGroup) continue

      for (const playerEntry of groupEntry.players ?? []) {
        const player = playerEntry.player ?? {}
        const playerId = toInt(player.id)
        if (!playerId) continue

        players.set(playerId, {
          id: playerId,
          name: asString(player.name) ?? `Player ${playerId}`,
          image_url: asString(player.image),
        })

        for (const statEntry of playerEntry.statistics ?? []) {
          rows.push({
            game_id: gameId,
            team_id: teamId,
            player_id: playerId,
            stat_group: statGroup,
            stat_name: asString(statEntry.name) ?? 'unknown',
            stat_value: asString(statEntry.value),
          })
        }
      }
    }
  }

  return { players: Array.from(players.values()), rows }
}

async function createApiClient(config: IngestConfig) {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  }

  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  })

  const apiBaseUrl = config.apiBaseUrl ?? defaultApiBaseUrl
  const apiHost = config.apiHost ?? defaultApiHost
  const apiHeaders = {
    'x-apisports-key': config.apiKey,
    'x-rapidapi-key': config.apiKey,
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
        console.warn(`[Ingest] Rate limited on ${path}. Retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }

    throw lastError
  }

  return { supabase, fetchEndpoint, fetchEndpointWithRetry }
}

export async function fetchAvailableSeasons(config: IngestConfig): Promise<AvailableSeason[]> {
  const apiBaseUrl = config.apiBaseUrl ?? defaultApiBaseUrl
  const apiHost = config.apiHost ?? defaultApiHost
  const response = await fetch(`${apiBaseUrl}/seasons`, {
    headers: {
      'x-apisports-key': config.apiKey,
      'x-rapidapi-key': config.apiKey,
      'x-rapidapi-host': apiHost,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`API request failed (${response.status}) ${apiBaseUrl}/seasons\n${body}`)
  }

  const payload = (await response.json()) as EndpointResponse<number>

  const seasons: AvailableSeason[] = []
  for (const season of payload.response) {
    const seasonYear = toInt(season)
    if (!seasonYear) continue

    seasons.push({
      season: seasonYear,
      current: false,
      startDate: null,
      endDate: null,
    })
  }

  return seasons.sort((left, right) => right.season - left.season)
}

async function persistGamePayload(
  supabase: SupabaseClient,
  payload: EndpointResponse<LiveGameApi>,
  defaultLeagueId: number,
): Promise<number[]> {
  const teams = new Map<number, { id: number; name: string; logo_url: string | null }>()
  const leagues = new Map<number, { id: number; name: string; logo_url: string | null }>()
  const games: Dict[] = []

  for (const item of payload.response) {
    const game = item.game ?? {}
    const gameTeams = item.teams ?? {}
    const homeTeam = asDict(gameTeams.home)
    const awayTeam = asDict(gameTeams.away)
    const homeTeamId = toInt(homeTeam.id)
    const awayTeamId = toInt(awayTeam.id)
    const gameId = toInt(game.id)
    const leagueId = toInt(item.league?.id) ?? defaultLeagueId

    if (!gameId || !homeTeamId || !awayTeamId) continue

    for (const [id, team] of [
      [homeTeamId, homeTeam],
      [awayTeamId, awayTeam],
    ] as const) {
      teams.set(id, {
        id,
        name: asString(team.name) ?? `Team ${id}`,
        logo_url: asString(team.logo),
      })
    }

    leagues.set(leagueId, {
      id: leagueId,
      name: asString(item.league?.name) ?? `League ${leagueId}`,
      logo_url: asString(item.league?.logo),
    })

    const scores = asDict(item.scores ?? game.scores)
    const homeScores = asDict(scores.home)
    const awayScores = asDict(scores.away)
    const venue = asDict(game.venue)
    const gameDate = getGameDateFields(game)

    games.push({
      id: gameId,
      league_id: leagueId,
      season: toInt(item.league?.season) ?? toInt(game.season),
      stage: pickText(game.stage),
      week: pickText(game.week),
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      ...gameDate,
      venue_name: pickText(venue.name),
      venue_city: pickText(venue.city),
      status_short: pickText(asDict(game.status).short),
      status_long: pickText(asDict(game.status).long),
      status_timer: pickText(asDict(game.status).timer),
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
      venue: pickText(venue.name, venue.city),
    })
  }

  if (!games.length) return []

  const { error: leagueError } = await supabase.from('leagues').upsert(Array.from(leagues.values()), { onConflict: 'id' })
  if (leagueError) throw leagueError

  const { error: teamError } = await supabase.from('teams').upsert(Array.from(teams.values()), { onConflict: 'id' })
  if (teamError) throw teamError

  const { error: gameError } = await supabase.from('games').upsert(games, { onConflict: 'id' })
  if (gameError) throw gameError

  return games.map((game) => game.id as number)
}

export async function refreshLiveGames(config: IngestConfig): Promise<number[]> {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const payload = await fetchEndpoint<LiveGameApi>('/games', { live: 'all', timezone: scheduleTimezone })
  return persistGamePayload(supabase, payload, config.leagueId ?? 1)
}

export async function refreshGameById(config: IngestConfig, gameId: number): Promise<number> {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const payload = await fetchEndpoint<LiveGameApi>('/games', { id: gameId, timezone: scheduleTimezone })
  const gameIds = await persistGamePayload(supabase, payload, config.leagueId ?? 1)

  if (!gameIds.includes(gameId)) {
    throw new Error(`Game ${gameId} was not returned by API-Sports.`)
  }

  return gameId
}

async function upsertTeams(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
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
    league: config.leagueId ?? 1,
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
    .filter((row): row is {
      id: number
      name: string
      code: string | null
      city: string | null
      coach: string | null
      owner: string | null
      stadium: string | null
      established: number | null
      logo_url: string | null
      country_name: string | null
      country_code: string | null
      country_flag_url: string | null
    } => Boolean(row))

  console.log(`[Ingest] Teams endpoint returned ${payload.response.length} items, inserting ${rows.length} teams:`, rows.map((r) => r.id).sort((a, b) => a - b))

  if (!rows.length) return 0
  const { error } = await supabase.from('teams').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

async function upsertPlayers(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
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
  type TeamApi = { id?: unknown }

  // API-Sports players are retrieved per-team for a season.
  const teamsPayload = await fetchEndpoint<TeamApi>('/teams', {
    league: config.leagueId ?? 1,
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

  console.log(
    `[Ingest] Players fetched from ${teamIds.length} teams, inserting ${rows.length} unique players`,
  )

  if (!rows.length) return 0
  const { error } = await supabase.from('players').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

async function upsertGames(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  type GameApi = {
    game?: Dict
    league?: Dict
    teams?: Dict
    scores?: Dict
  }
  type GameUpsertRow = {
    id: number
    league_id: number
    season: number
    stage: string | null
    week: string | null
    home_team_id: number
    away_team_id: number
    date_timezone: string | null
    game_date: string | null
    game_time: string | null
    game_timestamp: number | null
    venue_name: string | null
    venue_city: string | null
    status_short: string | null
    status_long: string | null
    status_timer: string | null
    home_q1: number | null
    home_q2: number | null
    home_q3: number | null
    home_q4: number | null
    home_ot: number | null
    home_total: number | null
    away_q1: number | null
    away_q2: number | null
    away_q3: number | null
    away_q4: number | null
    away_ot: number | null
    away_total: number | null
    venue: string | null
  }

  const payload = await fetchEndpoint<GameApi>('/games', {
    league: config.leagueId ?? 1,
    season,
    timezone: scheduleTimezone,
  })

  const rows = payload.response
    .map((item) => {
      const game = item.game ?? {}
      const teams = item.teams ?? {}
      const venue = game.venue as Dict | undefined
      const scores = (item.scores ?? (game.scores as Dict | undefined) ?? {}) as Dict
      const homeScores = (scores.home ?? {}) as Dict
      const awayScores = (scores.away ?? {}) as Dict
      const gameDate = getGameDateFields(game)
      const id = toInt(game.id)
      if (!id) return null

      const homeTeamId = toInt((teams.home as Dict | undefined)?.id)
      const awayTeamId = toInt((teams.away as Dict | undefined)?.id)

      // Skip games with invalid team IDs
      if (!homeTeamId || !awayTeamId) return null

      return {
        id,
        league_id: toInt(item.league?.id) ?? config.leagueId ?? 1,
        season,
        stage: pickText(game.stage),
        week: pickText(game.week),
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        ...gameDate,
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
      } satisfies GameUpsertRow
    })
    .filter(Boolean) as GameUpsertRow[]

  const teamIds = new Set<number>()
  rows.forEach((row) => {
    if (row.home_team_id) teamIds.add(row.home_team_id)
    if (row.away_team_id) teamIds.add(row.away_team_id)
  })
  console.log(`[Ingest] Games endpoint returned ${payload.response.length} items, inserting ${rows.length} games with team IDs:`, Array.from(teamIds).sort((a, b) => a - b))

  if (!rows.length) return 0
  const { error } = await supabase.from('games').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

export async function refreshSeasonSchedule(config: IngestConfig, season: number) {
  const teams = await upsertTeams(config, season)
  const games = await upsertGames(config, season)
  return { teams, games }
}

async function upsertGameEvents(config: IngestConfig, season: number) {
  const { supabase, fetchEndpointWithRetry } = await createApiClient(config)

  // Fetch all non-scheduled game IDs for the season from the DB
  const { data: gameRows, error: fetchError } = await supabase
    .from('games')
    .select('id')
    .eq('season', season)
    .neq('status_short', 'NS')
  if (fetchError) throw fetchError

  const gameIds = (gameRows ?? []).map((row: { id: number }) => row.id)
  if (!gameIds.length) {
    console.log(`[Ingest] No completed games found for season ${season}, skipping game events`)
    return 0
  }

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
  type EventPlayerUpsertRow = {
    id: number
    name: string
    image_url: string | null
  }

  const CONCURRENCY = 2
  let totalRows = 0

  for (let i = 0; i < gameIds.length; i += CONCURRENCY) {
    const batch = gameIds.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (gameId) => {
        const payload = await fetchEndpointWithRetry<GameEventsApi>('/games/events', { id: gameId })
        const eventPlayers = new Map<number, EventPlayerUpsertRow>()
        const rows = payload.response
          .map((item) => {
            const teamId = toInt(item.team?.id)
            if (!teamId) return null
            const playerId = toInt(item.player?.id)

            if (playerId) {
              eventPlayers.set(playerId, {
                id: playerId,
                name: asString(item.player?.name) ?? `Player ${playerId}`,
                image_url: asString(item.player?.image),
              })
            }

            return {
              game_id: gameId,
              team_id: teamId,
              player_id: playerId,
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

        if (eventPlayers.size) {
          const { error: playerError } = await supabase
            .from('players')
            .upsert(Array.from(eventPlayers.values()), { onConflict: 'id' })
          if (playerError) throw playerError
        }

        // Delete existing events for this game before re-inserting to handle re-runs
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

  console.log(`[Ingest] Upserted game_events=${totalRows} across ${gameIds.length} games`)
  return totalRows
}

async function upsertBookmakers(config: IngestConfig) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  type BookmakerApi = { id?: unknown; name?: unknown }
  const payload = await fetchEndpoint<BookmakerApi>('/odds/bookmakers', {})

  const rows = payload.response
    .map((item) => {
      const id = toInt(item.id)
      if (!id) return null
      return { id, name: asString(item.name) ?? `Bookmaker ${id}` }
    })
    .filter((row): row is { id: number; name: string } => Boolean(row))

  if (!rows.length) return 0
  const { error } = await supabase.from('bookmakers').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

async function upsertBetTypes(config: IngestConfig) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
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

  if (!rows.length) return 0
  const { error } = await supabase.from('bet_types').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

async function upsertOdds(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
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
    league: config.leagueId ?? 1,
    season,
  })

  // Collect all game IDs in this payload so we can delete stale rows in bulk
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

  if (!rows.length) return 0

  // Delete existing odds for these games before reinserting (handle re-runs)
  for (const gameId of gameIds) {
    const { error: delError } = await supabase.from('odds').delete().eq('game_id', gameId)
    if (delError) throw delError
  }

  const { error } = await supabase.from('odds').insert(rows)
  if (error) throw error
  return rows.length
}

async function upsertLeagueMetadata(config: IngestConfig) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  type LeagueApi = { league?: Dict; country?: Dict; seasons?: Dict[] }
  const payload = await fetchEndpoint<LeagueApi>('/leagues', { id: config.leagueId ?? 1 })

  const leagueRows: Dict[] = []
  const seasonRows: Dict[] = []

  for (const item of payload.response) {
    const league = item.league ?? {}
    const country = item.country ?? {}
    const leagueId = toInt(league.id)
    if (!leagueId) continue

    leagueRows.push({
      id: leagueId,
      name: asString(league.name) ?? `League ${leagueId}`,
      logo_url: asString(league.logo),
      country_name: asString(country.name),
      country_code: asString(country.code),
      country_flag_url: asString(country.flag),
    })

    for (const seasonItem of item.seasons ?? []) {
      const season = toInt(seasonItem.year)
      if (!season) continue
      const coverage = (seasonItem.coverage as Dict | undefined) ?? {}
      const games = (coverage.games as Dict | undefined) ?? {}
      const stats = (coverage.statistics as Dict | undefined) ?? {}
      const players = (stats.players as Dict | undefined) ?? {}

      seasonRows.push({
        league_id: leagueId,
        season_year: season,
        start_date: asString(seasonItem.start),
        end_date: asString(seasonItem.end),
        is_current: Boolean(seasonItem.current),
        cov_games_events: games.events === true,
        cov_stats_teams: games.teams === true || games.statistics_teams === true,
        cov_stats_players: games.players === true || games.statistics_players === true,
        cov_season_players: players.statistics === true,
        cov_players: coverage.players === true,
        cov_injuries: coverage.injuries === true,
        cov_standings: coverage.standings === true,
      })
    }
  }

  if (leagueRows.length) {
    const { error } = await supabase.from('leagues').upsert(leagueRows, { onConflict: 'id' })
    if (error) throw error
  }

  if (seasonRows.length) {
    const { error } = await supabase
      .from('league_seasons')
      .upsert(seasonRows, { onConflict: 'league_id,season_year' })
    if (error) throw error
  }

  return { leagues: leagueRows.length, leagueSeasons: seasonRows.length }
}

async function upsertInjuries(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  type InjuryApi = { player?: Dict; team?: Dict; injury?: Dict }
  const payload = await fetchEndpoint<InjuryApi>('/injuries', {
    league: config.leagueId ?? 1,
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

  if (!rows.length) return 0
  const { error } = await supabase.from('injuries').upsert(rows, { onConflict: 'player_id' })
  if (error) throw error
  return rows.length
}

async function upsertPlayerSeasonStats(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)

  console.log(`[Ingest] Fetching player stats for league ${config.leagueId ?? 1}, season ${season}...`)

  type PlayerStatsApi = {
    player?: Dict
    team?: Dict
    teams?: Array<{
      team?: Dict
      groups?: Array<{
        name?: unknown
        statistics?: Array<{ name?: unknown; value?: unknown }>
      }>
    }>
  }

  const payload = await fetchEndpoint<PlayerStatsApi>('/players/statistics', {
    league: config.leagueId ?? 1,
    season,
  })

  if (!payload.response || !Array.isArray(payload.response)) {
    console.warn('[Ingest] No player stats response or invalid format.')
    return 0
  }

  const rows: Dict[] = []
  let skippedPlayers = 0
  let skippedTeams = 0

  for (const item of payload.response) {
    // 1. Validate Player
    const playerId = toInt(item.player?.id)
    if (!playerId) {
      skippedPlayers++
      continue
    }

    const teamsList = item.teams ?? []

    for (const teamEntry of teamsList) {
      // 2. Validate Team
      const teamId = toInt(teamEntry.team?.id)
      if (!teamId) {
        skippedTeams++
        continue
      }

      const groupsList = teamEntry.groups ?? []

      for (const groupEntry of groupsList) {
        const statGroup = asString(groupEntry.name)
        if (!statGroup) continue // Skip empty group names, but don't increment skip count heavily unless needed

        const statsList = groupEntry.statistics ?? []

        for (const statEntry of statsList) {
          const statName = asString(statEntry.name)
          // We allow 'unknown' as a fallback if name is missing, but require at least a name structure
          if (!statName && statEntry.name == null) continue

          const statValue = asString(statEntry.value)

          // Construct the row
          rows.push({
            player_id: playerId,
            team_id: teamId,
            season,
            stat_group: statGroup,
            stat_name: statName ?? 'unknown_stat',
            stat_value: statValue,
          })
        }
      }
    }
  }

  console.log(`[Ingest] Processed ${payload.response.length} player entries. Generated ${rows.length} rows.`)
  if (skippedPlayers > 0) console.warn(`[Ingest] Skipped ${skippedPlayers} players due to invalid IDs.`)
  if (skippedTeams > 0) console.warn(`[Ingest] Skipped ${skippedTeams} teams due to invalid IDs.`)

  if (!rows.length) {
    console.log('[Ingest] No valid player stats rows to insert.')
    return 0
  }

  try {
    // Ensure the conflict target matches your DB schema exactly.
    // If you get a "there is no unique or exclusion constraint matching the ON CONFLICT specification" error,
    // you must add that constraint in your SQL migration first.
    const { error } = await supabase
      .from('player_season_stats')
      .upsert(rows, {
        onConflict: 'player_id,team_id,season,stat_group,stat_name',
        ignoreDuplicates: false // default is true for upsert usually, but explicit is good
      })

    if (error) {
      console.error('[Ingest] Error inserting player stats:', error)
      throw error
    }

    console.log(`[Ingest] Successfully inserted ${rows.length} player stat rows.`)
    return rows.length
  } catch (err) {
    console.error('[Ingest] Failed to insert player stats:', err)
    throw err
  }
}

async function upsertStandings(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
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
    league: config.leagueId ?? 1,
    season,
  })

  const rows = payload.response
    .map((item) => {
      const leagueId = toInt(item.league?.id)
      const teamId = toInt(item.team?.id)
      if (!leagueId || !teamId) return null

      return {
        league_id: leagueId,
        season: toInt(item.league?.season) ?? season,
        team_id: teamId,
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

  if (!rows.length) return 0
  const { error } = await supabase.from('standings').upsert(rows, { onConflict: 'league_id,season,team_id' })
  if (error) throw error
  return rows.length
}

async function upsertGameTeamStats(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const gamesPayload = await fetchEndpoint<GameTeamStatsApi>('/games/statistics/teams', {
    league: config.leagueId ?? 1,
    season,
  })

  const rows = gamesPayload.response.map((item) => mapGameTeamStatsItem(item)).filter(Boolean) as GameTeamStatsUpsertRow[]

  if (!rows.length) return 0
  const { error } = await supabase.from('game_team_stats').upsert(rows, { onConflict: 'game_id,team_id' })
  if (error) throw error
  return rows.length
}

export async function refreshGameTeamStatsByGameId(
  config: IngestConfig,
  gameId: number,
): Promise<GameTeamStatsUpsertRow[]> {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const payload = await fetchEndpoint<GameTeamStatsApi>('/games/statistics/teams', { id: gameId })

  const rows = payload.response.map((item) => mapGameTeamStatsItem(item, gameId)).filter(Boolean) as GameTeamStatsUpsertRow[]
  if (!rows.length) return []

  const { error } = await supabase.from('game_team_stats').upsert(rows, { onConflict: 'game_id,team_id' })
  if (error) throw error
  return rows
}

async function upsertGamePlayerStats(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const gamesPayload = await fetchEndpoint<GamePlayerStatsApi>('/games/statistics/players', {
    league: config.leagueId ?? 1,
    season,
  })

  const { rows } = mapGamePlayerStats(gamesPayload)

  if (!rows.length) return 0
  const { error } = await supabase
    .from('game_player_stats')
    .upsert(rows, { onConflict: 'game_id,team_id,player_id,stat_group,stat_name' })
  if (error) throw error
  return rows.length
}

export async function refreshGamePlayerStatsByGameId(
  config: IngestConfig,
  gameId: number,
  teamId?: number,
): Promise<GamePlayerStatUpsertRow[]> {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const payload = await fetchEndpoint<GamePlayerStatsApi>('/games/statistics/players', { id: gameId })
  const { players, rows } = mapGamePlayerStats(payload, gameId)
  const teamRows = teamId == null ? rows : rows.filter((row) => row.team_id === teamId)

  if (!teamRows.length) return []
  const playerIds = new Set(teamRows.map((row) => row.player_id))
  const selectedTeamPlayers = players.filter((player) => playerIds.has(player.id))

  const { error: playerError } = await supabase.from('players').upsert(selectedTeamPlayers, { onConflict: 'id' })
  if (playerError) throw playerError

  const { error } = await supabase
    .from('game_player_stats')
    .upsert(teamRows, { onConflict: 'game_id,team_id,player_id,stat_group,stat_name' })
  if (error) throw error
  return teamRows
}

export async function ingestSeason(config: IngestConfig, season: number): Promise<IngestSummary> {
  console.log(`[Ingest] Starting ingest for season ${season}`)

  console.log(`[Ingest] Step 1: Upserting league metadata...`)
  const leagueMetadata = await upsertLeagueMetadata(config)
  console.log(`[Ingest] Step 1 complete: ${leagueMetadata.leagues} leagues, ${leagueMetadata.leagueSeasons} seasons`)

  console.log(`[Ingest] Step 2: Upserting teams...`)
  const teams = await upsertTeams(config, season)
  console.log(`[Ingest] Step 2 complete: ${teams} teams`)

  console.log(`[Ingest] Step 3: Upserting players...`)
  const players = await upsertPlayers(config, season)
  console.log(`[Ingest] Step 3 complete: ${players} players`)

  console.log(`[Ingest] Step 4: Upserting games...`)
  const games = await upsertGames(config, season)
  console.log(`[Ingest] Step 4 complete: ${games} games`)

  console.log(`[Ingest] Step 5: Upserting game events...`)
  const gameEvents = await upsertGameEvents(config, season)
  console.log(`[Ingest] Step 5 complete: ${gameEvents} game events`)

  console.log(`[Ingest] Step 6: Upserting injuries...`)
  const injuries = await upsertInjuries(config, season)
  console.log(`[Ingest] Step 6 complete: ${injuries} injuries`)

  console.log(`[Ingest] Step 7: Upserting player season stats...`)
  const playerSeasonStats = await upsertPlayerSeasonStats(config, season)
  console.log(`[Ingest] Step 7 complete: ${playerSeasonStats} player season stats`)

  console.log(`[Ingest] Step 8: Upserting standings...`)
  const standings = await upsertStandings(config, season)
  console.log(`[Ingest] Step 8 complete: ${standings} standings`)

  console.log(`[Ingest] Step 9: Upserting game team stats...`)
  const gameTeamStats = await upsertGameTeamStats(config, season)
  console.log(`[Ingest] Step 9 complete: ${gameTeamStats} game team stats`)

  console.log(`[Ingest] Step 10: Upserting game player stats...`)
  const gamePlayerStats = await upsertGamePlayerStats(config, season)
  console.log(`[Ingest] Step 10 complete: ${gamePlayerStats} game player stats`)

  console.log(`[Ingest] Step 11: Upserting bookmakers...`)
  const bookmakers = await upsertBookmakers(config)
  console.log(`[Ingest] Step 11 complete: ${bookmakers} bookmakers`)

  console.log(`[Ingest] Step 12: Upserting bet types...`)
  const betTypes = await upsertBetTypes(config)
  console.log(`[Ingest] Step 12 complete: ${betTypes} bet types`)

  console.log(`[Ingest] Step 13: Upserting odds...`)
  const odds = await upsertOdds(config, season)
  console.log(`[Ingest] Step 13 complete: ${odds} odds rows`)

  console.log(`[Ingest] Season ${season} ingest complete!`)
  return {
    season,
    leagues: leagueMetadata.leagues,
    leagueSeasons: leagueMetadata.leagueSeasons,
    teams,
    players,
    games,
    gameEvents,
    injuries,
    playerSeasonStats,
    standings,
    gameTeamStats,
    gamePlayerStats,
    bookmakers,
    betTypes,
    odds,
  }
}