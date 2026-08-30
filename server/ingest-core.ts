import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AvailableSeason, IngestSummary } from '../src/api/contracts'

export type { AvailableSeason, IngestSummary } from '../src/api/contracts'

type Dict = Record<string, unknown>

type EndpointResponse<T> = {
  response: T[]
  errors?: unknown
}

type ApiClient = {
  supabase: SupabaseClient
  fetchEndpoint: <T>(path: string, params: Record<string, string | number>) => Promise<EndpointResponse<T>>
  fetchEndpointWithRetry: <T>(
    path: string,
    params: Record<string, string | number>,
    maxRetries?: number,
  ) => Promise<EndpointResponse<T>>
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

function describeApiErrors(errors: unknown): string | null {
  if (Array.isArray(errors)) {
    return errors.length ? errors.map(String).join('; ') : null
  }
  if (errors && typeof errors === 'object') {
    const entries = Object.entries(errors)
    return entries.length ? entries.map(([field, message]) => `${field}: ${String(message)}`).join('; ') : null
  }
  return errors ? String(errors) : null
}

export type IngestConfig = {
  supabaseUrl?: string
  serviceRoleKey?: string
  apiKey: string
  apiBaseUrl?: string
  apiHost?: string
  leagueId?: number
  apiRequestsPerMinute?: number
  beforeApiRequest?: (path: string) => void | Promise<void>
}

type LiveGameApi = {
  game?: Dict
  league?: Dict
  teams?: Dict
  scores?: Dict
}

type GameEventApi = {
  team?: Dict
  player?: Dict
  quarter?: unknown
  minute?: unknown
  time?: unknown
  type?: unknown
  comment?: unknown
  score?: Dict
  scores?: Dict
}

export type GameEventUpsertRow = {
  game_id: number
  team_id: number
  player_id: number | null
  quarter: string
  minute: string | null
  event_type: string
  comment: string | null
  score_home: number | null
  score_away: number | null
}

type EventPlayerUpsertRow = {
  id: number
  name: string
  image_url: string | null
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

type PlayerStatsApi = {
  player?: Dict
  teams?: Array<{
    team?: Dict
    groups?: Array<{
      name?: unknown
      statistics?: Array<{ name?: unknown; value?: unknown }>
    }>
  }>
}

type InjuryApi = {
  player?: Dict
  team?: Dict
  date?: unknown
  status?: unknown
  description?: unknown
}

type InjuryUpsertRow = {
  player_id: number
  team_id: number | null
  injury_date: string | null
  status: string | null
  description: string | null
  last_seen_at: string
  resolved_at: null
}

type StandingApi = {
  league?: Dict
  team?: Dict
  conference?: unknown
  division?: unknown
  position?: unknown
  won?: unknown
  lost?: unknown
  ties?: unknown
  points?: Dict
  records?: Dict
  streak?: unknown
}

type BetTypeApi = { id?: unknown; name?: unknown }

type OddsApi = {
  game?: Dict
  update?: unknown
  bookmakers?: Array<{
    id?: unknown
    bets?: Array<{
      id?: unknown
      values?: Array<{ value?: unknown; odd?: unknown }>
    }>
  }>
}

export type OddsUpsertRow = {
  game_id: number
  bookmaker_id: number
  bet_id: number
  bet_value: string
  odd: number
  provider_updated_at: string
}

export type CollectionSummary = {
  attempted: number
  succeeded: number
  failedIds: number[]
  emptyIds: number[]
  rowsUpserted: number
}

const defaultApiBaseUrl = 'https://v1.american-football.api-sports.io'
const defaultApiHost = 'v1.american-football.api-sports.io'
const scheduleTimezone = 'America/New_York'
const targetedGameRefreshCooldownMs = 60_000
const targetedGameRefreshConcurrency = 2
const dataRefreshConcurrency = 2
const oddsRefreshConcurrency = 2
const oddsUpsertBatchSize = 1_000
const oddsAvailabilityDays = 7
const apiClients = new WeakMap<IngestConfig, ApiClient>()
const apiRequestSchedulers = new Map<
  string,
  { nextRequestAt: number; queue: Promise<void> }
>()
const targetedGameRefreshes = new Map<
  string,
  { completedAt: number | null; promise: Promise<number> }
>()

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

function asIsoTimestamp(value: unknown): string | null {
  const text = asString(value)
  if (!text) return null
  const timestamp = new Date(text)
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString()
}

function asDict(value: unknown): Dict {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Dict
  }

  return {}
}

export function mapGameEventRows(gameId: number, events: GameEventApi[]) {
  const players = new Map<number, EventPlayerUpsertRow>()
  const rows = events
    .map((event) => {
      const teamId = toInt(event.team?.id)
      const playerId = toInt(event.player?.id)
      const quarter = asString(event.quarter)
      const eventType = asString(event.type)
      if (!teamId || !quarter || !eventType) return null

      if (playerId) {
        players.set(playerId, {
          id: playerId,
          name: asString(event.player?.name) ?? `Player ${playerId}`,
          image_url: asString(event.player?.image),
        })
      }

      const score = asDict(event.score ?? event.scores)
      const homeScore = score.home
      const awayScore = score.away
      return {
        game_id: gameId,
        team_id: teamId,
        player_id: playerId,
        quarter,
        minute: asString(event.minute ?? event.time),
        event_type: eventType,
        comment: asString(event.comment),
        score_home: toInt(asDict(homeScore).total ?? homeScore),
        score_away: toInt(asDict(awayScore).total ?? awayScore),
      }
    })
    .filter((row): row is GameEventUpsertRow => row !== null)

  return { players: Array.from(players.values()), rows }
}

export function mapBetTypeRows(items: BetTypeApi[]) {
  return items
    .map((item) => {
      const id = toInt(item.id)
      if (!id) return null
      return { id, name: asString(item.name) ?? `Bet ${id}` }
    })
    .filter((row): row is { id: number; name: string } => row !== null)
}

export function mapOddsRows(items: OddsApi[]) {
  const rows = new Map<string, OddsUpsertRow>()

  for (const item of items) {
    const gameId = toInt(item.game?.id)
    if (!gameId) continue
    const providerUpdatedAt = asIsoTimestamp(item.update)
    if (!providerUpdatedAt) {
      throw new Error(`Odds response for game ${gameId} is missing a valid update timestamp.`)
    }

    for (const bookmaker of item.bookmakers ?? []) {
      const bookmakerId = toInt(bookmaker.id)
      if (!bookmakerId) continue

      for (const bet of bookmaker.bets ?? []) {
        const betId = toInt(bet.id)
        if (!betId) continue

        for (const value of bet.values ?? []) {
          const betValue = asString(value.value)
          const odd = Number(value.odd)
          if (!betValue || !Number.isFinite(odd) || odd <= 0) continue

          const row = {
            game_id: gameId,
            bookmaker_id: bookmakerId,
            bet_id: betId,
            bet_value: betValue,
            odd,
            provider_updated_at: providerUpdatedAt,
          }
          const key = [gameId, bookmakerId, betId, betValue, providerUpdatedAt].join('\u0000')
          rows.set(key, row)
        }
      }
    }
  }

  return Array.from(rows.values())
}

function injuryEpisodeKey(row: {
  player_id: number
  team_id: number | null
  injury_date: string | null
  status: string | null
  description: string | null
}) {
  return [
    row.player_id,
    row.team_id ?? '',
    row.injury_date ?? '',
    row.status ?? '',
    row.description ?? '',
  ].join('\u0000')
}

export function mapInjuryRows(items: InjuryApi[], observedAt: string) {
  const lastSeenAt = asIsoTimestamp(observedAt)
  if (!lastSeenAt) throw new Error(`Invalid injury observation timestamp: ${observedAt}`)

  const players = new Map<number, EventPlayerUpsertRow>()
  const rows = new Map<string, InjuryUpsertRow>()

  for (const item of items) {
    const playerId = toInt(item.player?.id)
    if (!playerId) continue

    players.set(playerId, {
      id: playerId,
      name: asString(item.player?.name) ?? `Player ${playerId}`,
      image_url: asString(item.player?.image),
    })

    const row: InjuryUpsertRow = {
      player_id: playerId,
      team_id: toInt(item.team?.id),
      injury_date: asString(item.date),
      status: asString(item.status),
      description: asString(item.description),
      last_seen_at: lastSeenAt,
      resolved_at: null,
    }
    rows.set(injuryEpisodeKey(row), row)
  }

  return { players: Array.from(players.values()), rows: Array.from(rows.values()) }
}

export function mapPlayerSeasonStatRows(items: PlayerStatsApi[], season: number) {
  const players = new Map<number, EventPlayerUpsertRow>()
  const teams = new Map<number, { id: number; name: string; logo_url: string | null }>()
  const rows = new Map<string, {
    player_id: number
    team_id: number
    season: number
    stat_group: string
    stat_name: string
    stat_value: string | null
  }>()

  for (const item of items) {
    const playerId = toInt(item.player?.id)
    if (!playerId) continue

    players.set(playerId, {
      id: playerId,
      name: asString(item.player?.name) ?? `Player ${playerId}`,
      image_url: asString(item.player?.image),
    })

    for (const teamEntry of item.teams ?? []) {
      const teamId = toInt(teamEntry.team?.id)
      if (!teamId) continue

      teams.set(teamId, {
        id: teamId,
        name: asString(teamEntry.team?.name) ?? `Team ${teamId}`,
        logo_url: asString(teamEntry.team?.logo),
      })

      for (const groupEntry of teamEntry.groups ?? []) {
        const statGroup = asString(groupEntry.name)
        if (!statGroup) continue

        for (const statEntry of groupEntry.statistics ?? []) {
          const statName = asString(statEntry.name)
          if (!statName) continue
          const row = {
            player_id: playerId,
            team_id: teamId,
            season,
            stat_group: statGroup,
            stat_name: statName,
            stat_value: asString(statEntry.value),
          }
          const key = [playerId, teamId, season, statGroup, statName].join('\u0000')
          rows.set(key, row)
        }
      }
    }
  }

  return {
    players: Array.from(players.values()),
    teams: Array.from(teams.values()),
    rows: Array.from(rows.values()),
  }
}

export function mapStandingRows(items: StandingApi[], fallbackSeason: number) {
  return items
    .map((item) => {
      const leagueId = toInt(item.league?.id)
      const teamId = toInt(item.team?.id)
      if (!leagueId || !teamId) return null
      const records = asDict(item.records)
      const conference = asString(item.conference)
      const rawDivision = asString(item.division)
      const conferencePrefix = conference === 'American Football Conference'
        ? 'AFC'
        : conference === 'National Football Conference'
          ? 'NFC'
          : null
      const division = rawDivision && conferencePrefix && ['East', 'North', 'South', 'West'].includes(rawDivision)
        ? `${conferencePrefix} ${rawDivision}`
        : rawDivision

      return {
        league_id: leagueId,
        season: toInt(item.league?.season) ?? fallbackSeason,
        team_id: teamId,
        conference,
        division,
        position: toInt(item.position),
        won: toInt(item.won) ?? 0,
        lost: toInt(item.lost) ?? 0,
        ties: toInt(item.ties) ?? 0,
        points_for: toInt(item.points?.for),
        points_against: toInt(item.points?.against),
        points_diff: toInt(item.points?.difference),
        record_home: asString(records.home),
        record_road: asString(records.road),
        record_conference: asString(records.conference),
        record_division: asString(records.division),
        streak: asString(item.streak),
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
}

export function mapLeagueSeasonRow(leagueId: number, seasonItem: Dict) {
  const season = toInt(seasonItem.year)
  if (!season) return null
  const coverage = asDict(seasonItem.coverage)
  const games = asDict(coverage.games)
  const gameStatistics = asDict(games.statisitcs ?? games.statistics)
  const seasonStatistics = asDict(asDict(coverage.statistics).season)

  return {
    league_id: leagueId,
    season_year: season,
    start_date: asString(seasonItem.start),
    end_date: asString(seasonItem.end),
    is_current: Boolean(seasonItem.current),
    cov_games_events: games.events === true,
    cov_stats_teams: gameStatistics.teams === true,
    cov_stats_players: gameStatistics.players === true,
    cov_season_players: seasonStatistics.players === true,
    cov_players: coverage.players === true,
    cov_injuries: coverage.injuries === true,
    cov_standings: coverage.standings === true,
  }
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

function createApiClient(config: IngestConfig): ApiClient {
  const cachedClient = apiClients.get(config)
  if (cachedClient) return cachedClient

  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing env vars. Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  }

  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  })

  const apiBaseUrl = config.apiBaseUrl ?? defaultApiBaseUrl
  const apiHost = config.apiHost ?? defaultApiHost
  const requestsPerMinute = config.apiRequestsPerMinute ?? 240
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new Error('apiRequestsPerMinute must be a positive integer.')
  }
  const schedulerKey = `${apiBaseUrl}|${config.apiKey}|${requestsPerMinute}`
  const scheduler = apiRequestSchedulers.get(schedulerKey) ?? {
    nextRequestAt: 0,
    queue: Promise.resolve(),
  }
  apiRequestSchedulers.set(schedulerKey, scheduler)
  const requestIntervalMs = Math.ceil(60_000 / requestsPerMinute)
  const apiHeaders = {
    'x-apisports-key': config.apiKey,
    'x-rapidapi-key': config.apiKey,
    'x-rapidapi-host': apiHost,
  }

  function waitForRequestSlot() {
    const scheduled = scheduler.queue.then(async () => {
      const delayMs = Math.max(0, scheduler.nextRequestAt - Date.now())
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      scheduler.nextRequestAt = Date.now() + requestIntervalMs
    })
    scheduler.queue = scheduled.catch(() => undefined)
    return scheduled
  }

  async function fetchEndpoint<T>(path: string, params: Record<string, string | number>) {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => search.set(key, String(value)))
    const requestPath = `${path}${search.size ? `?${search.toString()}` : ''}`
    const url = `${apiBaseUrl}${requestPath}`
    const startedAt = Date.now()

    let result: Response
    try {
      await waitForRequestSlot()
      await config.beforeApiRequest?.(requestPath)
      result = await fetch(url, { headers: apiHeaders })
    } catch (error) {
      const durationMs = Date.now() - startedAt
      console.error(`[API-Sports] GET ${requestPath} -> network error in ${durationMs}ms`, error)
      throw error
    }
    if (!result.ok) {
      const body = await result.text()
      const durationMs = Date.now() - startedAt
      console.error(`[API-Sports] GET ${requestPath} -> ${result.status} in ${durationMs}ms`)
      throw new Error(`API request failed (${result.status}) ${url}\n${body}`)
    }

    let payload: EndpointResponse<T>
    try {
      payload = (await result.json()) as EndpointResponse<T>
    } catch (error) {
      const durationMs = Date.now() - startedAt
      console.error(`[API-Sports] GET ${requestPath} -> invalid JSON in ${durationMs}ms`, error)
      throw error
    }
    const apiErrors = describeApiErrors(payload.errors)
    if (apiErrors) {
      const durationMs = Date.now() - startedAt
      console.error(`[API-Sports] GET ${requestPath} -> API error in ${durationMs}ms: ${apiErrors}`)
      throw new Error(`API request failed ${url}\n${apiErrors}`)
    }

    const durationMs = Date.now() - startedAt
    const responseCount = Array.isArray(payload.response) ? payload.response.length : 0
    console.log(`[API-Sports] GET ${requestPath} -> ${result.status} in ${durationMs}ms (${responseCount} items)`)
    return payload
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
        const isTransient = isRateLimit || /\(5\d\d\)/.test(message) || error instanceof TypeError

        if (!isTransient || attempt === maxRetries) {
          throw error
        }

        const backoffMs = Math.min(8000, 500 * 2 ** attempt)
        console.warn(`[Ingest] Transient API failure on ${path}. Retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }

    throw lastError
  }

  const client = { supabase, fetchEndpoint, fetchEndpointWithRetry }
  apiClients.set(config, client)
  return client
}

async function collectById<T>(
  ids: number[],
  worker: (id: number) => Promise<T>,
  label: string,
) {
  const completed: Array<{ id: number; value: T }> = []
  const failedIds: number[] = []

  for (let index = 0; index < ids.length; index += dataRefreshConcurrency) {
    const batch = ids.slice(index, index + dataRefreshConcurrency)
    const results = await Promise.allSettled(batch.map((id) => worker(id)))
    results.forEach((result, resultIndex) => {
      const id = batch[resultIndex]
      if (result.status === 'fulfilled') {
        completed.push({ id, value: result.value })
      } else {
        failedIds.push(id)
        console.error(`[Ingest] ${label} failed for ID ${id}`, result.reason)
      }
    })
  }

  return { completed, failedIds }
}

async function fetchSeasonTeamIds(client: ApiClient, leagueId: number, season: number) {
  type TeamApi = { id?: unknown }
  const payload = await client.fetchEndpointWithRetry<TeamApi>('/teams', { league: leagueId, season })
  return payload.response
    .map((team) => toInt(team.id))
    .filter((teamId): teamId is number => teamId !== null)
}

async function fetchPlayedGameIds(supabase: SupabaseClient, season: number) {
  const { data, error } = await supabase
    .from('games')
    .select('id')
    .eq('season', season)
    .in('status_short', ['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'HT', 'FT', 'AOT'])
    .order('game_date')

  if (error) throw error
  return (data ?? [])
    .map((game: { id: unknown }) => toInt(game.id))
    .filter((gameId): gameId is number => gameId !== null)
}

export async function fetchAvailableSeasons(config: IngestConfig): Promise<AvailableSeason[]> {
  const { fetchEndpoint } = createApiClient(config)
  const payload = await fetchEndpoint<number>('/seasons', {})

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
  const client = createApiClient(config)
  const { supabase, fetchEndpoint } = client
  const leagueId = config.leagueId ?? 1
  const payload = await fetchEndpoint<LiveGameApi>('/games', {
    live: 'all',
    timezone: scheduleTimezone,
  })
  payload.response = payload.response.filter((item) => toInt(item.league?.id) === leagueId)
  const gameIds = await persistGamePayload(supabase, payload, leagueId)

  for (let index = 0; index < gameIds.length; index += targetedGameRefreshConcurrency) {
    const batch = gameIds.slice(index, index + targetedGameRefreshConcurrency)
    const results = await Promise.allSettled(batch.map((gameId) => replaceGameEventsById(client, gameId)))
    results.forEach((result, resultIndex) => {
      if (result.status === 'rejected') {
        console.error(`[Ingest] Could not refresh scoring events for live game ${batch[resultIndex]}`, result.reason)
      }
    })
  }

  return gameIds
}

export async function refreshGameById(config: IngestConfig, gameId: number): Promise<number> {
  return refreshGameByIdWithClient(createApiClient(config), config.leagueId ?? 1, gameId)
}

async function refreshGameByIdWithClient(client: ApiClient, leagueId: number, gameId: number) {
  const { supabase, fetchEndpoint } = client
  const payload = await fetchEndpoint<LiveGameApi>('/games', { id: gameId, timezone: scheduleTimezone })
  const gameIds = await persistGamePayload(supabase, payload, leagueId)

  if (!gameIds.includes(gameId)) {
    throw new Error(`Game ${gameId} was not returned by API-Sports.`)
  }

  return gameId
}

function getTargetedGameRefreshKey(config: IngestConfig, gameId: number) {
  return [
    config.supabaseUrl,
    config.apiBaseUrl ?? defaultApiBaseUrl,
    config.leagueId ?? 1,
    gameId,
  ].join('|')
}

function refreshTargetedGame(config: IngestConfig, client: ApiClient, gameId: number) {
  const key = getTargetedGameRefreshKey(config, gameId)
  const existing = targetedGameRefreshes.get(key)
  if (existing) {
    if (existing.completedAt == null) return existing.promise
    if (Date.now() - existing.completedAt < targetedGameRefreshCooldownMs) return Promise.resolve(0)
    targetedGameRefreshes.delete(key)
  }

  const entry: { completedAt: number | null; promise: Promise<number> } = {
    completedAt: null,
    promise: Promise.resolve(0),
  }
  entry.promise = refreshGameByIdWithClient(client, config.leagueId ?? 1, gameId)
    .then((refreshedGameId) => {
      entry.completedAt = Date.now()
      return refreshedGameId
    })
    .catch((error: unknown) => {
      if (targetedGameRefreshes.get(key) === entry) targetedGameRefreshes.delete(key)
      throw error
    })
  targetedGameRefreshes.set(key, entry)
  return entry.promise
}

export async function refreshGamesByIds(config: IngestConfig, gameIds: number[]) {
  if (gameIds.some((gameId) => !Number.isInteger(gameId) || gameId <= 0)) {
    throw new Error('gameIds must contain only positive integers.')
  }

  const uniqueGameIds = Array.from(new Set(gameIds))
  const client = createApiClient(config)
  let refreshedGames = 0

  for (let index = 0; index < uniqueGameIds.length; index += targetedGameRefreshConcurrency) {
    const batch = uniqueGameIds.slice(index, index + targetedGameRefreshConcurrency)
    const results = await Promise.all(batch.map((gameId) => refreshTargetedGame(config, client, gameId)))
    refreshedGames += results.filter((gameId) => gameId > 0).length
  }

  return refreshedGames
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

  console.log(`[Ingest] Teams endpoint returned ${payload.response.length} items; inserting ${rows.length} teams`)

  if (!rows.length) return 0
  const { error } = await supabase.from('teams').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

export async function refreshSeasonPlayers(config: IngestConfig, season: number) {
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
  const rosterRows = new Map<string, Dict>()
  const observedAt = new Date().toISOString()

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
      rosterRows.set(`${teamId}:${id}`, {
        season,
        league_id: config.leagueId ?? 1,
        team_id: teamId,
        player_id: id,
        position_group: asString(item.group),
        position: asString(item.position),
        jersey_number: toInt(item.number),
        last_seen_at: observedAt,
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
  const rosters = Array.from(rosterRows.values())
  if (rosters.length) {
    const { error: rosterError } = await supabase
      .from('team_rosters')
      .upsert(rosters, { onConflict: 'season,league_id,team_id,player_id' })
    if (rosterError) throw rosterError
  }
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

  console.log(`[Ingest] Games endpoint returned ${payload.response.length} items; upserting ${rows.length} games`)

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

export async function refreshSeasonGames(config: IngestConfig, season: number) {
  return upsertGames(config, season)
}

async function upsertGameEvents(config: IngestConfig, season: number) {
  const client = createApiClient(config)
  const { supabase } = client

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

  let totalRows = 0

  for (let index = 0; index < gameIds.length; index += targetedGameRefreshConcurrency) {
    const batch = gameIds.slice(index, index + targetedGameRefreshConcurrency)
    const rowCounts = await Promise.all(batch.map((gameId) => replaceGameEventsById(client, gameId)))
    totalRows += rowCounts.reduce((sum, rowCount) => sum + rowCount, 0)
  }

  console.log(`[Ingest] Upserted game_events=${totalRows} across ${gameIds.length} games`)
  return totalRows
}

async function replaceGameEventsById(client: ApiClient, gameId: number) {
  const payload = await client.fetchEndpointWithRetry<GameEventApi>('/games/events', { id: gameId })
  const { players, rows } = mapGameEventRows(gameId, payload.response)
  if (!rows.length) return 0

  if (players.length) {
    const { error: playerError } = await client.supabase
      .from('players')
      .upsert(players, { onConflict: 'id' })
    if (playerError) throw playerError
  }

  const { error: deleteError } = await client.supabase
    .from('game_events')
    .delete()
    .eq('game_id', gameId)
  if (deleteError) throw deleteError

  const { error: insertError } = await client.supabase.from('game_events').insert(rows)
  if (insertError) throw insertError
  return rows.length
}

export async function refreshGameEventsByGameId(config: IngestConfig, gameId: number) {
  return replaceGameEventsById(createApiClient(config), gameId)
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
  const payload = await fetchEndpoint<BetTypeApi>('/odds/bets', {})
  const rows = mapBetTypeRows(payload.response)

  if (!rows.length) return 0
  const { error } = await supabase.from('bet_types').upsert(rows, { onConflict: 'id' })
  if (error) throw error
  return rows.length
}

function getDateInScheduleTimezone(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: scheduleTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T12:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

async function getOddsEligibleGameIds(client: ApiClient, season: number, now = new Date()) {
  const currentDate = getDateInScheduleTimezone(now)
  const startDate = shiftDate(currentDate, -oddsAvailabilityDays)
  const endDate = shiftDate(currentDate, oddsAvailabilityDays)
  const { data, error } = await client.supabase
    .from('games')
    .select('id')
    .eq('season', season)
    .gte('game_date', startDate)
    .lte('game_date', endDate)
    .order('game_date')

  if (error) throw error
  return (data ?? [])
    .map((game: { id: unknown }) => toInt(game.id))
    .filter((gameId): gameId is number => gameId !== null)
}

async function upsertOddsRows(supabase: SupabaseClient, rows: OddsUpsertRow[]) {
  for (let index = 0; index < rows.length; index += oddsUpsertBatchSize) {
    const batch = rows.slice(index, index + oddsUpsertBatchSize)
    const { error } = await supabase
      .from('odds')
      .upsert(batch, {
        onConflict: 'game_id,bookmaker_id,bet_id,bet_value,provider_updated_at',
        ignoreDuplicates: false,
      })
    if (error) throw error
  }
}

async function upsertOdds(config: IngestConfig, season: number) {
  const client = createApiClient(config)
  const gameIds = await getOddsEligibleGameIds(client, season)
  if (!gameIds.length) {
    console.log(`[Ingest] No games in the odds availability window for season ${season}`)
    return 0
  }

  let totalRows = 0
  for (let index = 0; index < gameIds.length; index += oddsRefreshConcurrency) {
    const batch = gameIds.slice(index, index + oddsRefreshConcurrency)
    const payloads = await Promise.all(
      batch.map((gameId) => client.fetchEndpointWithRetry<OddsApi>('/odds', { game: gameId })),
    )

    for (const payload of payloads) {
      const rows = mapOddsRows(payload.response)
      await upsertOddsRows(client.supabase, rows)
      totalRows += rows.length
    }
  }

  console.log(`[Ingest] Upserted odds=${totalRows} across ${gameIds.length} eligible games`)
  return totalRows
}

export async function refreshSeasonOdds(config: IngestConfig, season: number) {
  const bookmakers = await upsertBookmakers(config)
  const betTypes = await upsertBetTypes(config)
  const odds = await upsertOdds(config, season)
  return { bookmakers, betTypes, odds }
}

export async function refreshLeagueMetadata(config: IngestConfig) {
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
      const row = mapLeagueSeasonRow(leagueId, seasonItem)
      if (row) seasonRows.push(row)
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

export async function refreshCurrentInjuries(
  config: IngestConfig,
  season: number,
): Promise<CollectionSummary> {
  const client = createApiClient(config)
  const teamIds = await fetchSeasonTeamIds(client, config.leagueId ?? 1, season)
  if (!teamIds.length) {
    throw new Error(`No teams were returned for league ${config.leagueId ?? 1}, season ${season}.`)
  }
  const observedAt = new Date().toISOString()
  const collection = await collectById(
    teamIds,
    (teamId) => client.fetchEndpointWithRetry<InjuryApi>('/injuries', { team: teamId }),
    'Injury refresh',
  )

  const players = new Map<number, EventPlayerUpsertRow>()
  const rows = new Map<string, InjuryUpsertRow>()
  for (const result of collection.completed) {
    const mapped = mapInjuryRows(result.value.response, observedAt)
    mapped.players.forEach((player) => players.set(player.id, player))
    mapped.rows.forEach((row) => rows.set(injuryEpisodeKey(row), row))
  }

  if (players.size) {
    const { error } = await client.supabase
      .from('players')
      .upsert(Array.from(players.values()), { onConflict: 'id' })
    if (error) throw error
  }

  const injuryRows = Array.from(rows.values())
  if (injuryRows.length) {
    const { error } = await client.supabase
      .from('injuries')
      .upsert(injuryRows, {
        onConflict: 'player_id,team_id,injury_date,status,description',
        ignoreDuplicates: false,
      })
    if (error) throw error
  }

  if (!collection.failedIds.length) {
    const { data: activeRows, error: activeError } = await client.supabase
      .from('injuries')
      .select('id,player_id,team_id,injury_date,status,description')
      .is('resolved_at', null)
      .in('team_id', teamIds)
    if (activeError) throw activeError

    const resolvedIds = (activeRows ?? [])
      .filter((row) => !rows.has(injuryEpisodeKey(row)))
      .map((row) => row.id as number)
    for (let index = 0; index < resolvedIds.length; index += 1_000) {
      const { error } = await client.supabase
        .from('injuries')
        .update({ resolved_at: observedAt })
        .in('id', resolvedIds.slice(index, index + 1_000))
      if (error) throw error
    }
  }

  return {
    attempted: teamIds.length,
    succeeded: collection.completed.length,
    failedIds: collection.failedIds,
    emptyIds: collection.completed
      .filter((result) => result.value.response.length === 0)
      .map((result) => result.id),
    rowsUpserted: injuryRows.length,
  }
}

export async function refreshPlayerSeasonStats(
  config: IngestConfig,
  season: number,
): Promise<CollectionSummary> {
  const client = createApiClient(config)
  const teamIds = await fetchSeasonTeamIds(client, config.leagueId ?? 1, season)
  const collection = await collectById(
    teamIds,
    (teamId) => client.fetchEndpointWithRetry<PlayerStatsApi>(
      '/players/statistics',
      { team: teamId, season },
    ),
    'Player season statistics refresh',
  )

  const players = new Map<number, EventPlayerUpsertRow>()
  const teams = new Map<number, { id: number; name: string; logo_url: string | null }>()
  const rows = new Map<string, ReturnType<typeof mapPlayerSeasonStatRows>['rows'][number]>()
  for (const result of collection.completed) {
    const mapped = mapPlayerSeasonStatRows(result.value.response, season)
    mapped.players.forEach((player) => players.set(player.id, player))
    mapped.teams.forEach((team) => teams.set(team.id, team))
    mapped.rows.forEach((row) => {
      const key = [row.player_id, row.team_id, row.season, row.stat_group, row.stat_name].join('\u0000')
      rows.set(key, row)
    })
  }

  if (teams.size) {
    const { error } = await client.supabase
      .from('teams')
      .upsert(Array.from(teams.values()), { onConflict: 'id' })
    if (error) throw error
  }
  if (players.size) {
    const { error } = await client.supabase
      .from('players')
      .upsert(Array.from(players.values()), { onConflict: 'id' })
    if (error) throw error
  }

  const statRows = Array.from(rows.values())
  for (let index = 0; index < statRows.length; index += 1_000) {
    const { error } = await client.supabase
      .from('player_season_stats')
      .upsert(statRows.slice(index, index + 1_000), {
        onConflict: 'player_id,team_id,season,stat_group,stat_name',
        ignoreDuplicates: false,
      })
    if (error) throw error
  }

  return {
    attempted: teamIds.length,
    succeeded: collection.completed.length,
    failedIds: collection.failedIds,
    emptyIds: collection.completed
      .filter((result) => result.value.response.length === 0)
      .map((result) => result.id),
    rowsUpserted: statRows.length,
  }
}

export async function refreshSeasonStandings(config: IngestConfig, season: number) {
  const { supabase, fetchEndpoint } = await createApiClient(config)
  const payload = await fetchEndpoint<StandingApi>('/standings', {
    league: config.leagueId ?? 1,
    season,
  })
  const rows = mapStandingRows(payload.response, season)

  if (!rows.length) return 0
  const { error } = await supabase.from('standings').upsert(rows, { onConflict: 'league_id,season,team_id' })
  if (error) throw error
  return rows.length
}

async function upsertGameTeamStats(config: IngestConfig, season: number) {
  const client = createApiClient(config)
  const gameIds = await fetchPlayedGameIds(client.supabase, season)
  const collection = await collectById(
    gameIds,
    (gameId) => refreshGameTeamStatsByGameIdWithClient(client, gameId),
    'Game team statistics refresh',
  )

  return {
    attempted: gameIds.length,
    succeeded: collection.completed.length,
    failedIds: collection.failedIds,
    emptyIds: collection.completed
      .filter((result) => result.value.length === 0)
      .map((result) => result.id),
    rowsUpserted: collection.completed.reduce((total, result) => total + result.value.length, 0),
  }
}

export async function refreshGameTeamStatsByGameId(
  config: IngestConfig,
  gameId: number,
): Promise<GameTeamStatsUpsertRow[]> {
  return refreshGameTeamStatsByGameIdWithClient(createApiClient(config), gameId)
}

async function refreshGameTeamStatsByGameIdWithClient(client: ApiClient, gameId: number) {
  const payload = await client.fetchEndpointWithRetry<GameTeamStatsApi>('/games/statistics/teams', { id: gameId })
  const rows = payload.response.map((item) => mapGameTeamStatsItem(item, gameId)).filter(Boolean) as GameTeamStatsUpsertRow[]

  if (rows.length) {
    const { error } = await client.supabase
      .from('game_team_stats')
      .upsert(rows, { onConflict: 'game_id,team_id' })
    if (error) throw error
  }

  if (!rows.length) return rows

  const { data: existingRows, error: existingError } = await client.supabase
    .from('game_team_stats')
    .select('id,team_id')
    .eq('game_id', gameId)
  if (existingError) throw existingError

  const returnedTeamIds = new Set(rows.map((row) => row.team_id))
  const staleIds = (existingRows ?? [])
    .filter((row) => !returnedTeamIds.has(row.team_id as number))
    .map((row) => row.id as number)
  if (staleIds.length) {
    const { error } = await client.supabase
      .from('game_team_stats')
      .delete()
      .in('id', staleIds)
    if (error) throw error
  }
  return rows
}

async function upsertGamePlayerStats(config: IngestConfig, season: number) {
  const client = createApiClient(config)
  const gameIds = await fetchPlayedGameIds(client.supabase, season)
  const collection = await collectById(
    gameIds,
    (gameId) => refreshGamePlayerStatsByGameIdWithClient(client, gameId),
    'Game player statistics refresh',
  )

  return {
    attempted: gameIds.length,
    succeeded: collection.completed.length,
    failedIds: collection.failedIds,
    emptyIds: collection.completed
      .filter((result) => result.value.length === 0)
      .map((result) => result.id),
    rowsUpserted: collection.completed.reduce((total, result) => total + result.value.length, 0),
  }
}

export async function refreshGamePlayerStatsByGameId(
  config: IngestConfig,
  gameId: number,
  teamId?: number,
): Promise<GamePlayerStatUpsertRow[]> {
  return refreshGamePlayerStatsByGameIdWithClient(createApiClient(config), gameId, teamId)
}

async function refreshGamePlayerStatsByGameIdWithClient(
  client: ApiClient,
  gameId: number,
  teamId?: number,
) {
  const payload = await client.fetchEndpointWithRetry<GamePlayerStatsApi>('/games/statistics/players', { id: gameId })
  const { players, rows } = mapGamePlayerStats(payload, gameId)
  const teamRows = teamId == null ? rows : rows.filter((row) => row.team_id === teamId)

  if (teamRows.length) {
    const playerIds = new Set(teamRows.map((row) => row.player_id))
    const selectedTeamPlayers = players.filter((player) => playerIds.has(player.id))
    const { error: playerError } = await client.supabase
      .from('players')
      .upsert(selectedTeamPlayers, { onConflict: 'id' })
    if (playerError) throw playerError

    for (let index = 0; index < teamRows.length; index += 1_000) {
      const { error } = await client.supabase
        .from('game_player_stats')
        .upsert(teamRows.slice(index, index + 1_000), {
          onConflict: 'game_id,team_id,player_id,stat_group,stat_name',
        })
      if (error) throw error
    }
  }

  if (!teamRows.length) return teamRows

  const currentKeys = new Set(teamRows.map((row) => [
    row.team_id,
    row.player_id,
    row.stat_group,
    row.stat_name,
  ].join('\u0000')))
  const existingRows: Array<{
    id: number
    team_id: number
    player_id: number
    stat_group: string
    stat_name: string
  }> = []
  for (let from = 0; ; from += 1_000) {
    let query = client.supabase
      .from('game_player_stats')
      .select('id,team_id,player_id,stat_group,stat_name')
      .eq('game_id', gameId)
    if (teamId != null) query = query.eq('team_id', teamId)
    const { data, error } = await query.order('id').range(from, from + 999)
    if (error) throw error
    existingRows.push(...(data ?? []))
    if ((data ?? []).length < 1_000) break
  }

  const staleIds = existingRows
    .filter((row) => !currentKeys.has([
      row.team_id,
      row.player_id,
      row.stat_group,
      row.stat_name,
    ].join('\u0000')))
    .map((row) => row.id)
  for (let index = 0; index < staleIds.length; index += 1_000) {
    const { error } = await client.supabase
      .from('game_player_stats')
      .delete()
      .in('id', staleIds.slice(index, index + 1_000))
    if (error) throw error
  }

  return teamRows
}

export async function refreshSeasonStatistics(config: IngestConfig, season: number) {
  const leagueMetadata = await refreshLeagueMetadata(config)
  const standings = await refreshSeasonStandings(config, season)
  const playerSeasonStats = await refreshPlayerSeasonStats(config, season)
  const gameTeamStats = await upsertGameTeamStats(config, season)
  const gamePlayerStats = await upsertGamePlayerStats(config, season)
  return { leagueMetadata, standings, playerSeasonStats, gameTeamStats, gamePlayerStats }
}

export async function ingestSeason(config: IngestConfig, season: number): Promise<IngestSummary> {
  console.log(`[Ingest] Starting ingest for season ${season}`)

  console.log(`[Ingest] Step 1: Upserting league metadata...`)
  const leagueMetadata = await refreshLeagueMetadata(config)
  console.log(`[Ingest] Step 1 complete: ${leagueMetadata.leagues} leagues, ${leagueMetadata.leagueSeasons} seasons`)

  console.log(`[Ingest] Step 2: Upserting teams...`)
  const teams = await upsertTeams(config, season)
  console.log(`[Ingest] Step 2 complete: ${teams} teams`)

  console.log(`[Ingest] Step 3: Upserting players...`)
  const players = await refreshSeasonPlayers(config, season)
  console.log(`[Ingest] Step 3 complete: ${players} players`)

  console.log(`[Ingest] Step 4: Upserting games...`)
  const games = await upsertGames(config, season)
  console.log(`[Ingest] Step 4 complete: ${games} games`)

  console.log(`[Ingest] Step 5: Upserting game events...`)
  const gameEvents = await upsertGameEvents(config, season)
  console.log(`[Ingest] Step 5 complete: ${gameEvents} game events`)

  console.log(`[Ingest] Step 6: Upserting injuries...`)
  const injurySummary = await refreshCurrentInjuries(config, season)
  const injuries = injurySummary.rowsUpserted
  console.log(
    `[Ingest] Step 6 complete: ${injuries} injuries; `
    + `${injurySummary.succeeded}/${injurySummary.attempted} teams succeeded`,
  )

  console.log(`[Ingest] Step 7: Upserting player season stats...`)
  const playerSeasonStatsSummary = await refreshPlayerSeasonStats(config, season)
  const playerSeasonStats = playerSeasonStatsSummary.rowsUpserted
  console.log(
    `[Ingest] Step 7 complete: ${playerSeasonStats} player season stats; `
    + `${playerSeasonStatsSummary.succeeded}/${playerSeasonStatsSummary.attempted} teams succeeded`,
  )

  console.log(`[Ingest] Step 8: Upserting standings...`)
  const standings = await refreshSeasonStandings(config, season)
  console.log(`[Ingest] Step 8 complete: ${standings} standings`)

  console.log(`[Ingest] Step 9: Upserting game team stats...`)
  const gameTeamStatsSummary = await upsertGameTeamStats(config, season)
  const gameTeamStats = gameTeamStatsSummary.rowsUpserted
  console.log(
    `[Ingest] Step 9 complete: ${gameTeamStats} game team stats; `
    + `${gameTeamStatsSummary.succeeded}/${gameTeamStatsSummary.attempted} games succeeded`,
  )

  console.log(`[Ingest] Step 10: Upserting game player stats...`)
  const gamePlayerStatsSummary = await upsertGamePlayerStats(config, season)
  const gamePlayerStats = gamePlayerStatsSummary.rowsUpserted
  console.log(
    `[Ingest] Step 10 complete: ${gamePlayerStats} game player stats; `
    + `${gamePlayerStatsSummary.succeeded}/${gamePlayerStatsSummary.attempted} games succeeded`,
  )

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