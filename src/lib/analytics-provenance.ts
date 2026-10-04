import type { AnalyticsSnapshot } from '../../server/analytics-core'

export function analyticsScopeLabel(snapshot: AnalyticsSnapshot) {
  const scope = snapshot.evidenceScope
  if (!scope) return 'legacy selected-game sample; effective history scope was not recorded'
  const stage = scope.stage ?? (scope.excludedStage ? `all stages except ${scope.excludedStage}` : 'all stages')
  const cutoff = scope.beforeKickoff == null ? '' : `, before ${new Date(scope.beforeKickoff * 1000).toISOString()}`
  return `${scope.season} ${stage}${cutoff}`
}

export function analyticsProvenance(snapshot: AnalyticsSnapshot): string[] {
  const notes = [
    `Evidence: ${analyticsScopeLabel(snapshot)}. ${snapshot.summary.games} selected completed games; this is not necessarily a league-wide or similar-matchup sample.`,
    `Snapshot generated ${snapshot.generatedAt}. Saved source data is not automatically refreshed for follow-ups.`,
    'ATS and over rates exclude pushes and ungraded games. Statistics use each metric\'s valid observations, not its ATS grading count.',
    'Injury dates describe injury records, not refresh dates. Last observed timestamps, when supplied, do not establish final game-day availability.',
    'Pregame odds are stored current consensus, not closing lines. Provider freshness and opening-line movement are not established by the snapshot timestamp.',
    `${snapshot.dataQuality.gamesMissingSpread} games lack a graded spread; ${snapshot.dataQuality.gamesMissingTotal} lack a graded total; ${snapshot.dataQuality.gamesMissingRequiredTeamStats} lack complete required team statistics.`,
    ...(snapshot.dataQuality.warnings ?? []),
  ]
  if (snapshot.schemaVersion === 1) {
    notes.push('Legacy report: existing messages were not fact-selection validated. Missing scope, metric coverage, or source observations require a new analysis; they cannot be inferred from old prose.')
  }
  for (const [label, collection] of [
    ['game detail', snapshot.games],
    ['team trends', snapshot.teamTrends],
    ['team-stat trends', snapshot.teamStatTrends],
    ['standings', snapshot.standings],
    ['injuries', snapshot.currentInjuries],
    ['player statistics', snapshot.playerStats],
  ] as const) {
    if (collection.truncated) notes.push(`${label}: ${collection.included} of ${collection.total} items supplied; aggregate facts may cover more games than the displayed evidence IDs.`)
  }
  return notes
}
