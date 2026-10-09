import type { AnalyticsSnapshot, AnalyticsStatMetric, AnalyticsTeamLocationTrend } from './analytics-core'
import { analyticsProvenance, analyticsScopeLabel } from '../src/lib/analytics-provenance'

export type AnalyticsFactSection =
  | 'matchup' | 'results' | 'team' | 'statistics' | 'standings' | 'injuries' | 'players' | 'limitations'

export type AnalyticsFact = {
  id: string
  section: AnalyticsFactSection
  scope: string
  metric: string
  value: number | null
  unit: string | null
  statement: string
  teamId?: number
  playerId?: number
  gameIds: number[]
  comparisonKey?: string
}

export type AnalyticsFactCatalog = { facts: AnalyticsFact[]; total: number; truncated: boolean }

const MAX_REPORT_FACTS = 600
export const MAX_REPORT_FACT_CONTEXT_CHARS = 60_000
const formatNumber = (value: number | null) => value == null ? 'unavailable' : String(value)
const percent = (value: number | null) => value == null ? 'unavailable' : `${Number((value * 100).toFixed(2))}%`

export function analyticsPromptFact(fact: AnalyticsFact) {
  return {
    id: fact.id,
    statement: fact.statement,
    ...(fact.comparisonKey ? {
      comparisonKey: fact.comparisonKey, teamId: fact.teamId, value: fact.value, unit: fact.unit,
    } : {}),
  }
}

export function buildAnalyticsFacts(snapshot: AnalyticsSnapshot): AnalyticsFactCatalog {
  const facts: AnalyticsFact[] = []
  const scope = analyticsScopeLabel(snapshot)
  function add(
    id: string, section: AnalyticsFactSection, metric: string, statement: string,
    options: Partial<Pick<AnalyticsFact, 'value' | 'unit' | 'teamId' | 'playerId' | 'gameIds' | 'comparisonKey'>> = {},
  ) {
    facts.push({ id, section, scope, metric, statement, value: null, unit: null, gameIds: [], ...options })
  }
  analyticsProvenance(snapshot).forEach((note, index) => add(`limitation.${index}`, 'limitations', 'limitation', note))
  add('limitation.market-history', 'limitations', 'market-history',
    'Opening odds and line movement are unavailable in this report context. External lines or predictions in the conversation are not verified source facts.')
  add('limitation.prediction', 'limitations', 'prediction',
    'These are descriptive observations, not predictive probabilities, guarantees, or betting advice.')
  const target = snapshot.targetMatchup
  if (target) {
    add('matchup.identity', 'matchup', 'identity',
      `Game ${target.gameId}: ${target.awayTeam.name} (away, team ${target.awayTeam.id}) at ${target.homeTeam.name} (home, team ${target.homeTeam.id}); ${target.season}, ${target.stage ?? 'stage unknown'}, ${target.week ?? 'week unknown'}.`,
      { gameIds: [target.gameId] })
    add('matchup.schedule', 'matchup', 'schedule',
      `Kickoff ${new Date(target.kickoff.timestamp * 1000).toISOString()}; status ${target.status.short}; stored venue ${target.venue.name ?? 'unknown'}, ${target.venue.city ?? 'city unknown'}.`,
      { gameIds: [target.gameId] })
    add('matchup.spread', 'matchup', 'current-home-spread',
      `Stored current consensus home spread for ${target.homeTeam.name}: ${formatNumber(target.currentConsensusOdds.homeSpread)} (negative favors the home team); retrieved for snapshot ${snapshot.generatedAt}, provider freshness unknown.`,
      { value: target.currentConsensusOdds.homeSpread, unit: 'points', gameIds: [target.gameId] })
    add('matchup.total', 'matchup', 'current-total',
      `Stored current consensus total: ${formatNumber(target.currentConsensusOdds.total)}; retrieved for snapshot ${snapshot.generatedAt}, not a closing line.`,
      { value: target.currentConsensusOdds.total, unit: 'points', gameIds: [target.gameId] })
  }
  const summary = snapshot.summary
  add('sample.spread', 'results', 'sample-home-covers',
    `Selected-game sample (${scope}): ${summary.spread.homeCovers} home covers, ${summary.spread.awayCovers} away covers, ${summary.spread.pushes} pushes, ${summary.spread.ungraded} ungraded spreads. Home cover rate ${percent(summary.spread.homeCoverRate)} across ${summary.spread.homeCovers + summary.spread.awayCovers} decisions. This is not an individual team's ATS record.`)
  add('sample.totals', 'results', 'sample-totals',
    `Selected-game sample (${scope}): ${summary.totals.overs} overs, ${summary.totals.unders} unders, ${summary.totals.pushes} pushes, ${summary.totals.ungraded} ungraded totals; over rate ${percent(summary.totals.overRate)} across ${summary.totals.overs + summary.totals.unders} decisions.`)
  add('sample.deltas', 'results', 'sample-deltas',
    `Selected-game sample: average home spread delta ${formatNumber(summary.spread.averageDelta)}; average total delta ${formatNumber(summary.totals.averageDelta)}. Missing deltas are excluded.`)

  function teamFacts(trend: AnalyticsTeamLocationTrend, location: 'all' | 'home' | 'away') {
    const prefix = `team.${trend.teamId}.${location}`
    const label = `${trend.teamName}, ${location === 'all' ? 'all locations' : `${location} games`} (${scope})`
    const gameIds = snapshot.games.items.filter((game) =>
      location === 'home' ? game.homeTeamId === trend.teamId
        : location === 'away' ? game.awayTeamId === trend.teamId
          : game.homeTeamId === trend.teamId || game.awayTeamId === trend.teamId).map((game) => game.gameId)
    const options = { teamId: trend.teamId, gameIds }
    add(`${prefix}.ats`, 'team', 'ats',
      `${label}: ${trend.games} appearances; ${trend.atsWins}-${trend.atsLosses}-${trend.atsPushes} ATS (wins-losses-pushes), ${trend.atsUngraded} ungraded. ATS win rate ${percent(trend.atsWinRate)} over ${trend.atsWins + trend.atsLosses} decisions.`, options)
    add(`${prefix}.totals`, 'team', 'totals',
      `${label}: ${trend.overs}-${trend.unders}-${trend.totalPushes} totals (overs-unders-pushes), ${trend.totalsUngraded} ungraded; over rate ${percent(trend.overRate)} over ${trend.overs + trend.unders} decisions.`, options)
    for (const [metric, value, description] of [
      ['pointsFor', trend.averagePointsFor, 'points scored'],
      ['pointsAgainst', trend.averagePointsAgainst, 'points conceded'],
      ['spreadDelta', trend.averageTeamSpreadDelta, 'team-perspective spread delta'],
    ] as const) {
      add(`${prefix}.${metric}`, 'team', metric,
        `${label}: average ${description} ${formatNumber(value)}${metric === 'spreadDelta' ? '; games without a spread delta excluded' : ` across ${trend.games} games`}.`,
        { ...options, value, unit: 'points', comparisonKey: `${scope}:${location}:${metric}` })
    }
  }
  for (const trend of snapshot.teamTrends.items) {
    teamFacts(trend, 'all')
    if (trend.locationSplits) {
      teamFacts(trend.locationSplits.home, 'home')
      teamFacts(trend.locationSplits.away, 'away')
    }
  }
  for (const trend of snapshot.teamStatTrends.items) {
    const metrics: Array<[AnalyticsStatMetric, number | null | undefined, string, string]> = [
      ['totalYards', trend.averageTotalYards, 'total yards', 'yards'],
      ['passYards', trend.averagePassYards, 'passing yards', 'yards'],
      ['rushYards', trend.averageRushYards, 'rushing yards', 'yards'],
      ['turnovers', trend.averageTurnovers, 'turnovers committed (not turnover differential)', 'turnovers'],
      ['sacks', trend.averageSacks, 'provider sacks (not sacks allowed)', 'sacks'],
      ['sacksAllowed', trend.averageSacksAllowed, 'sacks allowed from offensive sacks/yardage', 'sacks'],
    ]
    const expected = snapshot.teamTrends.items.find((item) => item.teamId === trend.teamId)?.games
    for (const [metric, value, label, unit] of metrics) {
      const sample = trend.metricSamples?.[metric]
      const coverage = sample
        ? `sum ${formatNumber(sample.sum)}, ${sample.count} valid observations${expected == null ? '' : ` of ${expected} eligible games`}`
        : 'legacy field-specific sample coverage unknown; regenerate to establish the denominator'
      add(`stats.${trend.teamId}.${metric}`, 'statistics', metric,
        `${trend.teamName} (${scope}): average ${label} ${formatNumber(value ?? null)} per observed game; ${coverage}.`,
        {
          teamId: trend.teamId, gameIds: sample?.gameIds ?? [], value: value ?? null, unit,
          ...(sample ? { comparisonKey: `${scope}:statistics:${metric}` } : {}),
        })
    }
  }
  for (const standing of snapshot.standings.items) {
    add(`standing.${standing.team_id}`, 'standings', 'standing',
      `${standing.teamName}: stored season standings ${standing.won}-${standing.lost}-${standing.ties}; ${standing.division ?? 'division unknown'}, position ${standing.position ?? 'unknown'}, streak ${standing.streak ?? 'unknown'}; points for ${formatNumber(standing.points_for)}, points against ${formatNumber(standing.points_against)}. Standings observation time unknown; not an ATS record.`,
      { teamId: standing.team_id })
  }
  if (snapshot.preset === 'matchup_preview' && target) {
    const breakdown = (values: Array<string | null | undefined>) => {
      const counts = new Map<string, number>()
      for (const value of values) {
        const label = value?.trim() || 'unknown'
        counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      return [...counts].sort(([left], [right]) => left.localeCompare(right))
        .map(([label, count]) => `${label}: ${count}`).join(', ')
    }
    for (const team of [target.awayTeam, target.homeTeam]) {
      const records = snapshot.currentInjuries.items.filter((injury) => injury.team_id === team.id)
      add(`injury-summary.${team.id}`, 'injuries', 'injury-summary',
        records.length
          ? `${team.name}: ${records.length} supplied injury records; reported statuses (${breakdown(records.map((injury) => injury.status))}); positions (${breakdown(records.map((injury) => injury.position))}). Counts describe supplied records, not unique injured players or confirmed game-time availability.${snapshot.currentInjuries.truncated ? ' The injury snapshot is truncated; these are not complete team totals.' : ''}`
          : `${team.name}: no current injury records were supplied for this team; this does not confirm that the team is healthy.${snapshot.currentInjuries.truncated ? ' The injury snapshot is truncated; omitted records may include this team.' : ''}`,
        { teamId: team.id, value: records.length, unit: 'supplied injury records' })
    }
  }
  snapshot.currentInjuries.items.forEach((injury, index) => {
    add(`injury.${index}`, 'injuries', 'injury',
      `${injury.playerName}${injury.position ? ` (${injury.position})` : ''}, ${injury.teamName ?? 'team unknown'}: reported status ${injury.status ?? 'unknown'}, ${injury.description ?? 'description unavailable'}; injury date ${injury.injury_date ?? 'unknown'}, first observed ${injury.first_seen_at ?? 'unknown'}, last observed ${injury.last_seen_at ?? 'unknown'}. This is a current stored injury record, not confirmed game-time availability.`,
      { playerId: injury.player_id, ...(injury.team_id == null ? {} : { teamId: injury.team_id }) })
  })
  snapshot.playerStats.items.forEach((stat, index) => {
    add(`player-stat.${index}`, 'players', 'player-stat',
      `${stat.playerName}${stat.position ? ` (${stat.position})` : ''}: supplied ${stat.scope} ${stat.stat_group} / ${stat.stat_name}: ${stat.stat_value ?? 'unavailable'}. Season statistics are stored current totals, not necessarily a pre-kickoff historical snapshot.`,
      { teamId: stat.team_id, playerId: stat.player_id, gameIds: stat.game_id == null ? [] : [stat.game_id] })
  })
  for (const game of snapshot.games.items) {
    add(`game.${game.gameId}.score`, 'results', 'score',
      `Game ${game.gameId}, ${game.gameDate ?? 'date unknown'}, ${game.stage ?? 'stage unknown'}: ${game.awayTeamName} (away) ${game.awayScore}, ${game.homeTeamName} (home) ${game.homeScore}; final total ${game.finalTotal}.`,
      { gameIds: [game.gameId] })
    add(`game.${game.gameId}.lines`, 'results', 'closing-lines',
      `Game ${game.gameId}: historical closing home spread ${formatNumber(game.closingHomeSpread)}, home-perspective delta ${formatNumber(game.spreadDelta)}, result ${game.spreadResult}; closing total ${formatNumber(game.closingTotal)}, total delta ${formatNumber(game.totalDelta)}, result ${game.totalResult}.`,
      { gameIds: [game.gameId] })
  }
  const priority: Record<AnalyticsFactSection, number> = {
    limitations: 0, matchup: 1, team: 5, statistics: 6, injuries: 4,
    standings: 7, results: 8, players: 9,
  }
  const rank = (fact: AnalyticsFact) => {
    if (fact.id.startsWith('sample.')) return 1
    if (fact.metric === 'injury-summary') return 2
    if (/^team\.\d+\.all\.(ats|totals)$/.test(fact.id)) return 2
    if (/^stats\.\d+\.(turnovers|sacksAllowed)$/.test(fact.id)) return 3
    if (/^team\.\d+\.(home|away)\./.test(fact.id)) return 10
    return priority[fact.section]
  }
  facts.sort((left, right) => rank(left) - rank(right))
  const included: AnalyticsFact[] = []
  let contextChars = 2
  for (const fact of facts) {
    const chars = JSON.stringify(analyticsPromptFact(fact)).length + (included.length ? 1 : 0)
    if (included.length === MAX_REPORT_FACTS || contextChars + chars > MAX_REPORT_FACT_CONTEXT_CHARS) break
    included.push(fact)
    contextChars += chars
  }
  return { facts: included, total: facts.length, truncated: included.length < facts.length }
}
