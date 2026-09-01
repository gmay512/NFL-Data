export type AnalyticsPreset = 'game_review' | 'season_overview' | 'team_analysis' | 'trend_comparison'

export type AnalyticsFilters = {
  season: number
  stage?: string
  week?: string
  teamId?: number
  comparisonTeamId?: number
  gameId?: number
}

export type BettingGameRow = {
  game_id: number
  season: number
  stage: string | null
  week: string | null
  game_date: string | null
  game_timestamp: number | null
  away_team_id: number
  away_team_name: string
  home_team_id: number
  home_team_name: string
  away_score: number
  home_score: number
  final_total: number
  home_margin: number
  closing_home_spread: number | null
  spread_bookmaker_count: number | null
  spread_delta: number | null
  spread_result: 'away_cover' | 'home_cover' | 'push' | 'ungraded'
  closing_total: number | null
  total_bookmaker_count: number | null
  total_delta: number | null
  total_result: 'over' | 'push' | 'under' | 'ungraded'
}

export type AnalyticsTeamStatRow = {
  game_id: number
  team_id: number
  yards_total: number | null
  pass_yards: number | null
  rush_yards: number | null
  turnovers_total: number | null
  sacks: number | null
}

export type AnalyticsStandingRow = {
  team_id: number
  conference: string | null
  division: string | null
  position: number | null
  won: number
  lost: number
  ties: number
  points_for: number | null
  points_against: number | null
  streak: string | null
}

export type AnalyticsInjuryRow = {
  player_id: number
  team_id: number | null
  injury_date: string | null
  status: string | null
  description: string | null
}

export type AnalyticsPlayerStatRow = {
  scope: 'game' | 'season'
  game_id?: number
  team_id: number
  player_id: number
  stat_group: string
  stat_name: string
  stat_value: string | null
}

export type AnalyticsPlayerRow = {
  id: number
  name: string
  position: string | null
}

export type AnalyticsSourceData = {
  games: BettingGameRow[]
  teamStats: AnalyticsTeamStatRow[]
  standings: AnalyticsStandingRow[]
  injuries: AnalyticsInjuryRow[]
  playerStats: AnalyticsPlayerStatRow[]
  players: AnalyticsPlayerRow[]
}

export type AnalyticsLimits = {
  games: number
  injuries: number
  playerStats: number
  standings: number
  teamStatTrends: number
  teamTrends: number
}

export type BoundedAnalyticsItems<T> = {
  total: number
  included: number
  truncated: boolean
  items: T[]
}

type ResultCounts = {
  graded: number
  pushes: number
  ungraded: number
}

export type AnalyticsSnapshot = {
  schemaVersion: 1
  generatedAt: string
  preset: AnalyticsPreset
  filters: AnalyticsFilters
  definitions: {
    spreadDelta: string
    totalDelta: string
    rates: string
    injuries: string
  }
  summary: {
    games: number
    spread: ResultCounts & {
      homeCovers: number
      awayCovers: number
      homeCoverRate: number | null
      averageDelta: number | null
    }
    totals: ResultCounts & {
      overs: number
      unders: number
      overRate: number | null
      averageDelta: number | null
    }
  }
  teamTrends: BoundedAnalyticsItems<{
    teamId: number
    teamName: string
    games: number
    atsWins: number
    atsLosses: number
    atsPushes: number
    atsUngraded: number
    atsWinRate: number | null
    overs: number
    unders: number
    totalPushes: number
    totalsUngraded: number
    overRate: number | null
    averageTeamSpreadDelta: number | null
  }>
  teamStatTrends: BoundedAnalyticsItems<{
    teamId: number
    teamName: string
    games: number
    averageTotalYards: number | null
    averagePassYards: number | null
    averageRushYards: number | null
    averageTurnovers: number | null
    averageSacks: number | null
  }>
  games: BoundedAnalyticsItems<{
    gameId: number
    gameDate: string | null
    stage: string | null
    week: string | null
    awayTeamId: number
    awayTeamName: string
    awayScore: number
    homeTeamId: number
    homeTeamName: string
    homeScore: number
    finalTotal: number
    homeMargin: number
    closingHomeSpread: number | null
    spreadBookmakerCount: number | null
    spreadDelta: number | null
    spreadResult: BettingGameRow['spread_result']
    closingTotal: number | null
    totalBookmakerCount: number | null
    totalDelta: number | null
    totalResult: BettingGameRow['total_result']
  }>
  standings: BoundedAnalyticsItems<AnalyticsStandingRow & { teamName: string }>
  currentInjuries: BoundedAnalyticsItems<AnalyticsInjuryRow & { playerName: string; teamName: string | null }>
  playerStats: BoundedAnalyticsItems<AnalyticsPlayerStatRow & {
    playerName: string
    position: string | null
  }>
  dataQuality: {
    gamesMissingSpread: number
    gamesMissingTotal: number
    gamesMissingRequiredTeamStats: number
  }
}

export class AnalyticsValidationError extends Error {}

export const DEFAULT_ANALYTICS_LIMITS: AnalyticsLimits = {
  games: 100,
  injuries: 50,
  playerStats: 120,
  standings: 32,
  teamStatTrends: 32,
  teamTrends: 32,
}

const gamePlayerStatWhitelist = new Set([
  'defense|forced fumbles',
  'defense|interceptions',
  'defense|sacks',
  'defense|total tackles',
  'passing|completion pct',
  'passing|interceptions',
  'passing|passing touchdowns',
  'passing|quaterback rating',
  'passing|yards',
  'receiving|receiving targets',
  'receiving|receiving touchdowns',
  'receiving|receiving yards',
  'receiving|receptions',
  'rushing|rushing attempts',
  'rushing|rushing touchdowns',
  'rushing|yards',
])

const seasonPlayerStatWhitelist = new Set([
  'defensive|ff',
  'defensive|sacks',
  'defensive|tackles',
  'passing|interceptions',
  'passing|passing touch downs',
  'passing|rating',
  'passing|yards',
  'receiving|receiving touch downs',
  'receiving|targets',
  'receiving|total receptions',
  'receiving|yards',
  'rushing|rushing touch downs',
  'rushing|total rushes',
  'rushing|yards',
])

function asRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyticsValidationError('Analytics filters must be an object.')
  }
  return value as Record<string, unknown>
}

function optionalPositiveInteger(value: unknown, name: string) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new AnalyticsValidationError(`${name} must be a positive integer.`)
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AnalyticsValidationError(`${name} must be a positive integer.`)
  }
  return parsed
}

function optionalFilterText(value: unknown, name: string) {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string') throw new AnalyticsValidationError(`${name} must be text.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 100) {
    throw new AnalyticsValidationError(`${name} must contain 1 to 100 characters.`)
  }
  return trimmed
}

export function validateAnalyticsFilters(preset: AnalyticsPreset, value: unknown): AnalyticsFilters {
  const input = asRecord(value)
  const season = Number(input.season)
  if (!Number.isInteger(season) || season < 1900 || season > 2100) {
    throw new AnalyticsValidationError('season must be an integer from 1900 through 2100.')
  }

  const filters: AnalyticsFilters = {
    season,
    stage: optionalFilterText(input.stage, 'stage'),
    week: optionalFilterText(input.week, 'week'),
    teamId: optionalPositiveInteger(input.teamId, 'teamId'),
    comparisonTeamId: optionalPositiveInteger(input.comparisonTeamId, 'comparisonTeamId'),
    gameId: optionalPositiveInteger(input.gameId, 'gameId'),
  }

  if (preset === 'team_analysis' && filters.teamId == null) {
    throw new AnalyticsValidationError('teamId is required for team analysis.')
  }
  if (preset === 'game_review' && filters.gameId == null) {
    throw new AnalyticsValidationError('gameId is required for game review.')
  }
  if (preset === 'trend_comparison') {
    if (filters.teamId == null || filters.comparisonTeamId == null) {
      throw new AnalyticsValidationError('teamId and comparisonTeamId are required for trend comparison.')
    }
    if (filters.teamId === filters.comparisonTeamId) {
      throw new AnalyticsValidationError('Trend comparison requires two different teams.')
    }
  }

  return Object.fromEntries(
    Object.entries(filters).filter(([, entry]) => entry !== undefined),
  ) as AnalyticsFilters
}

function round(value: number, digits = 3) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function average(values: Array<number | null | undefined>) {
  const numericValues = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (!numericValues.length) return null
  return round(numericValues.reduce((total, value) => total + value, 0) / numericValues.length)
}

function rate(numerator: number, denominator: number) {
  return denominator ? round(numerator / denominator, 4) : null
}

function bounded<T>(items: T[], limit: number): BoundedAnalyticsItems<T> {
  const includedItems = items.slice(0, limit)
  return {
    total: items.length,
    included: includedItems.length,
    truncated: includedItems.length < items.length,
    items: includedItems,
  }
}

function teamNamesById(games: BettingGameRow[]) {
  const names = new Map<number, string>()
  for (const game of games) {
    names.set(game.away_team_id, game.away_team_name)
    names.set(game.home_team_id, game.home_team_name)
  }
  return names
}

function buildSummary(games: BettingGameRow[]): AnalyticsSnapshot['summary'] {
  const homeCovers = games.filter((game) => game.spread_result === 'home_cover').length
  const awayCovers = games.filter((game) => game.spread_result === 'away_cover').length
  const spreadPushes = games.filter((game) => game.spread_result === 'push').length
  const spreadUngraded = games.filter((game) => game.spread_result === 'ungraded').length
  const overs = games.filter((game) => game.total_result === 'over').length
  const unders = games.filter((game) => game.total_result === 'under').length
  const totalPushes = games.filter((game) => game.total_result === 'push').length
  const totalUngraded = games.filter((game) => game.total_result === 'ungraded').length

  return {
    games: games.length,
    spread: {
      graded: games.length - spreadUngraded,
      homeCovers,
      awayCovers,
      pushes: spreadPushes,
      ungraded: spreadUngraded,
      homeCoverRate: rate(homeCovers, homeCovers + awayCovers),
      averageDelta: average(games.map((game) => game.spread_delta)),
    },
    totals: {
      graded: games.length - totalUngraded,
      overs,
      unders,
      pushes: totalPushes,
      ungraded: totalUngraded,
      overRate: rate(overs, overs + unders),
      averageDelta: average(games.map((game) => game.total_delta)),
    },
  }
}

function buildTeamTrends(games: BettingGameRow[], names: Map<number, string>) {
  type MutableTrend = AnalyticsSnapshot['teamTrends']['items'][number] & {
    spreadDeltas: number[]
  }
  const trends = new Map<number, MutableTrend>()

  for (const [teamId, teamName] of names) {
    trends.set(teamId, {
      teamId,
      teamName,
      games: 0,
      atsWins: 0,
      atsLosses: 0,
      atsPushes: 0,
      atsUngraded: 0,
      atsWinRate: null,
      overs: 0,
      unders: 0,
      totalPushes: 0,
      totalsUngraded: 0,
      overRate: null,
      averageTeamSpreadDelta: null,
      spreadDeltas: [],
    })
  }

  for (const game of games) {
    for (const [teamId, isHome] of [
      [game.away_team_id, false],
      [game.home_team_id, true],
    ] as const) {
      const trend = trends.get(teamId)
      if (!trend) continue
      trend.games += 1

      if (game.spread_result === 'ungraded') trend.atsUngraded += 1
      else if (game.spread_result === 'push') trend.atsPushes += 1
      else if (
        (isHome && game.spread_result === 'home_cover')
        || (!isHome && game.spread_result === 'away_cover')
      ) trend.atsWins += 1
      else trend.atsLosses += 1

      if (game.spread_delta != null) {
        trend.spreadDeltas.push(isHome ? game.spread_delta : -game.spread_delta)
      }
      if (game.total_result === 'over') trend.overs += 1
      else if (game.total_result === 'under') trend.unders += 1
      else if (game.total_result === 'push') trend.totalPushes += 1
      else trend.totalsUngraded += 1
    }
  }

  return Array.from(trends.values())
    .map(({ spreadDeltas, ...trend }) => ({
      ...trend,
      atsWinRate: rate(trend.atsWins, trend.atsWins + trend.atsLosses),
      overRate: rate(trend.overs, trend.overs + trend.unders),
      averageTeamSpreadDelta: average(spreadDeltas),
    }))
    .sort((left, right) =>
      (right.atsWinRate ?? -1) - (left.atsWinRate ?? -1)
      || right.games - left.games
      || left.teamName.localeCompare(right.teamName)
      || left.teamId - right.teamId)
}

function buildTeamStatTrends(teamStats: AnalyticsTeamStatRow[], names: Map<number, string>) {
  const rowsByTeam = new Map<number, AnalyticsTeamStatRow[]>()
  for (const row of teamStats) {
    const rows = rowsByTeam.get(row.team_id) ?? []
    rows.push(row)
    rowsByTeam.set(row.team_id, rows)
  }

  return Array.from(rowsByTeam)
    .map(([teamId, rows]) => ({
      teamId,
      teamName: names.get(teamId) ?? `Team ${teamId}`,
      games: new Set(rows.map((row) => row.game_id)).size,
      averageTotalYards: average(rows.map((row) => row.yards_total)),
      averagePassYards: average(rows.map((row) => row.pass_yards)),
      averageRushYards: average(rows.map((row) => row.rush_yards)),
      averageTurnovers: average(rows.map((row) => row.turnovers_total)),
      averageSacks: average(rows.map((row) => row.sacks)),
    }))
    .sort((left, right) => right.games - left.games
      || left.teamName.localeCompare(right.teamName)
      || left.teamId - right.teamId)
}

function isWhitelistedPlayerStat(row: AnalyticsPlayerStatRow) {
  const key = `${row.stat_group.trim().toLowerCase()}|${row.stat_name.trim().toLowerCase()}`
  return row.scope === 'game'
    ? gamePlayerStatWhitelist.has(key)
    : seasonPlayerStatWhitelist.has(key)
}

function numericStatValue(value: string | null) {
  if (value == null) return Number.NEGATIVE_INFINITY
  const match = value.replaceAll(',', '').match(/[+-]?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : Number.NEGATIVE_INFINITY
}

function balancePlayerStatCategories<T extends {
  playerName: string
  player_id: number
  stat_group: string
  stat_name: string
  stat_value: string | null
}>(items: T[]) {
  const categories = new Map<string, T[]>()
  for (const item of items) {
    const key = `${item.stat_group.trim().toLowerCase()}|${item.stat_name.trim().toLowerCase()}`
    const rows = categories.get(key) ?? []
    rows.push(item)
    categories.set(key, rows)
  }

  const orderedCategories = Array.from(categories)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rows]) => rows.sort((left, right) =>
      numericStatValue(right.stat_value) - numericStatValue(left.stat_value)
      || left.playerName.localeCompare(right.playerName)
      || left.player_id - right.player_id))

  const balanced: T[] = []
  for (let index = 0; ; index += 1) {
    let added = false
    for (const rows of orderedCategories) {
      if (rows[index]) {
        balanced.push(rows[index])
        added = true
      }
    }
    if (!added) return balanced
  }
}

export function buildAnalyticsSnapshot(
  preset: AnalyticsPreset,
  filters: AnalyticsFilters,
  source: AnalyticsSourceData,
  generatedAt = new Date().toISOString(),
  limits: AnalyticsLimits = DEFAULT_ANALYTICS_LIMITS,
): AnalyticsSnapshot {
  const names = teamNamesById(source.games)
  const focusTeamIds = new Set(
    [filters.teamId, filters.comparisonTeamId].filter((teamId): teamId is number => teamId != null),
  )
  const includeTeam = (teamId: number) => !focusTeamIds.size || focusTeamIds.has(teamId)
  const players = new Map(source.players.map((player) => [player.id, player]))
  const expectedTeamStats = new Set(
    source.games.flatMap((game) => [
      [game.away_team_id, `${game.game_id}:${game.away_team_id}`],
      [game.home_team_id, `${game.game_id}:${game.home_team_id}`],
    ] as const)
      .filter(([teamId]) => includeTeam(teamId))
      .map(([, key]) => key),
  )
  for (const stats of source.teamStats) expectedTeamStats.delete(`${stats.game_id}:${stats.team_id}`)

  const gameItems = [...source.games]
    .sort((left, right) => (right.game_timestamp ?? 0) - (left.game_timestamp ?? 0) || right.game_id - left.game_id)
    .map((game) => ({
      gameId: game.game_id,
      gameDate: game.game_date,
      stage: game.stage,
      week: game.week,
      awayTeamId: game.away_team_id,
      awayTeamName: game.away_team_name,
      awayScore: game.away_score,
      homeTeamId: game.home_team_id,
      homeTeamName: game.home_team_name,
      homeScore: game.home_score,
      finalTotal: game.final_total,
      homeMargin: game.home_margin,
      closingHomeSpread: game.closing_home_spread,
      spreadBookmakerCount: game.spread_bookmaker_count,
      spreadDelta: game.spread_delta,
      spreadResult: game.spread_result,
      closingTotal: game.closing_total,
      totalBookmakerCount: game.total_bookmaker_count,
      totalDelta: game.total_delta,
      totalResult: game.total_result,
    }))

  const standings = source.standings
    .map((standing) => ({ ...standing, teamName: names.get(standing.team_id) ?? `Team ${standing.team_id}` }))
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER)
      || left.teamName.localeCompare(right.teamName))

  const injuries = source.injuries
    .map((injury) => ({
      ...injury,
      playerName: players.get(injury.player_id)?.name ?? `Player ${injury.player_id}`,
      teamName: injury.team_id == null ? null : names.get(injury.team_id) ?? `Team ${injury.team_id}`,
    }))
    .sort((left, right) => (right.injury_date ?? '').localeCompare(left.injury_date ?? '')
      || left.playerName.localeCompare(right.playerName)
      || left.player_id - right.player_id)

  const playerStats = balancePlayerStatCategories(source.playerStats
    .filter(isWhitelistedPlayerStat)
    .map((stat) => ({
      ...stat,
      playerName: players.get(stat.player_id)?.name ?? `Player ${stat.player_id}`,
      position: players.get(stat.player_id)?.position ?? null,
    })))

  return {
    schemaVersion: 1,
    generatedAt,
    preset,
    filters,
    definitions: {
      spreadDelta: 'Home final margin plus closing home spread; positive means home cover.',
      totalDelta: 'Final combined score minus closing total; positive means over.',
      rates: 'Win rates exclude pushes and ungraded games.',
      injuries: 'Current active injury records, not historical injury state at game time.',
    },
    summary: buildSummary(source.games),
    teamTrends: bounded(
      buildTeamTrends(source.games, names).filter((trend) => includeTeam(trend.teamId)),
      limits.teamTrends,
    ),
    teamStatTrends: bounded(
      buildTeamStatTrends(source.teamStats, names).filter((trend) => includeTeam(trend.teamId)),
      limits.teamStatTrends,
    ),
    games: bounded(gameItems, limits.games),
    standings: bounded(standings, limits.standings),
    currentInjuries: bounded(injuries, limits.injuries),
    playerStats: bounded(playerStats, limits.playerStats),
    dataQuality: {
      gamesMissingSpread: source.games.filter((game) => game.spread_result === 'ungraded').length,
      gamesMissingTotal: source.games.filter((game) => game.total_result === 'ungraded').length,
      gamesMissingRequiredTeamStats: new Set(
        Array.from(expectedTeamStats, (key) => Number(key.split(':')[0])),
      ).size,
    },
  }
}
