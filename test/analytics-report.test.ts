import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAnalyticsSnapshot, parseSacksAllowed, type AnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import { analyticsPromptFact, buildAnalyticsFacts, MAX_REPORT_FACT_CONTEXT_CHARS } from '../server/analytics-facts'
import { AnalyticsReportError, buildAnalyticsReportSchema, renderAnalyticsReport } from '../server/analytics-report'
import { analyticsProvenance } from '../src/lib/analytics-provenance'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AnalyticsReportContent } from '../src/features/analytics/AnalyticsReportContent'

(globalThis as typeof globalThis & { React: typeof React }).React = React

const source: AnalyticsSourceData = {
  games: Array.from({ length: 4 }, (_, index) => ({
    game_id: index + 1, season: 2026, stage: 'Regular Season', week: `Week ${index + 1}`,
    game_date: '2026-09-01', game_timestamp: 100 + index,
    away_team_id: index % 2 ? 26 : 29, away_team_name: index % 2 ? 'Houston' : 'Dallas',
    home_team_id: index % 2 ? 29 : 26, home_team_name: index % 2 ? 'Dallas' : 'Houston',
    away_score: 23, home_score: 25, final_total: 48, home_margin: 2,
    closing_home_spread: -3, spread_bookmaker_count: 2,
    spread_delta: index === 3 ? null : -1,
    spread_result: index === 3 ? 'ungraded' : 'away_cover',
    closing_total: 48, total_bookmaker_count: 2, total_delta: 0, total_result: 'push',
  })),
  teamStats: Array.from({ length: 4 }, (_, index) => ({
    game_id: index + 1, team_id: 29, yards_total: 300,
    pass_yards: index === 3 ? null : 200, rush_yards: 100,
    turnovers_total: index === 3 ? 0 : 1, sacks: 3,
    sacks_yards_lost: index === 3 ? 'unrecognized' : '1-8',
  })),
  standings: [],
  injuries: [
    { player_id: 10, team_id: 29, injury_date: '2026-09-20', status: 'Questionable', description: 'Knee', last_seen_at: '2026-10-02T12:00:00Z' },
    { player_id: 11, team_id: 26, injury_date: null, status: 'Out', description: null },
  ],
  players: [{ id: 10, name: 'Known player', position: 'CB' }, { id: 11, name: 'Unknown position', position: null }],
  playerStats: [],
  targetMatchup: {
    gameId: 21570, season: 2026, status: { short: 'NS', long: 'Not Started' },
    kickoff: { date: '2026-10-04', timestamp: 1791122400 },
    stage: 'Regular Season', week: 'Week 4', venue: { name: 'Stored stadium', city: 'Houston' },
    awayTeam: { id: 29, name: 'Dallas' }, homeTeam: { id: 26, name: 'Houston' },
    currentConsensusOdds: { homeSpread: -3, total: 48 },
  },
  evidenceScope: { season: 2026, stage: 'Regular Season', excludedStage: null, beforeKickoff: 1791122400, teamIds: [26, 29] },
}
const snapshot = buildAnalyticsSnapshot('season_overview', { season: 2026, gameId: 21570 }, source, '2026-10-04T12:00:00Z')
const output = (...ids: string[]) => JSON.stringify({ observations: ids.map((factId) => ({ kind: 'fact', factId })) })
const render = (content: string, context = snapshot) => renderAnalyticsReport(content, context, 'stop')
const fact = (id: string, context = snapshot) => buildAnalyticsFacts(context).facts.find((item) => item.id === id)!

describe('canonical analytics facts', () => {
  it('uses field-specific sums and counts rather than the ATS or box-score denominator', () => {
    const trend = snapshot.teamStatTrends.items[0]
    assert.equal(trend.averageTurnovers, 0.75)
    assert.deepEqual(trend.metricSamples?.turnovers, { sum: 3, count: 4, gameIds: [1, 2, 3, 4] })
    assert.equal(trend.metricSamples?.passYards.count, 3)
    assert.equal(trend.metricSamples?.sacksAllowed.count, 3)
    assert.match(fact('stats.29.turnovers').statement, /0.75.*sum 3, 4 valid observations of 4 eligible games/)
    assert.match(fact('stats.29.passYards').statement, /3 valid observations of 4 eligible games/)
    assert(snapshot.dataQuality.gamesMissingRequiredTeamStats > 0)
    assert.match(snapshot.dataQuality.warnings?.[0] ?? '', /sacks allowed unavailable/)
  })

  it('separates pooled results, team records, home/away samples, pushes, and ungraded games', () => {
    assert.equal(snapshot.summary.games, 4)
    assert.equal(snapshot.teamTrends.items.find((trend) => trend.teamId === 29)?.games, 4)
    assert.match(fact('sample.spread').statement, /not an individual team's ATS record/)
    assert.match(fact('team.29.all.ats').statement, /2-1-0 ATS.*1 ungraded.*3 decisions/)
    assert.match(fact('team.29.home.ats').statement, /2 appearances.*0-1-0 ATS.*1 ungraded/)
    assert.match(fact('team.29.all.totals').statement, /0-0-4 totals.*unavailable over 0 decisions/)
  })

  it('never reinterprets provider sacks as sacks allowed', () => {
    assert.equal(parseSacksAllowed(' 2 - 15 '), 2)
    for (const value of [null, 'unknown', '2', '2/15', '2-15-extra', '-2-15']) assert.equal(parseSacksAllowed(value), null)
    assert.equal(fact('stats.29.sacks').value, 3)
    assert.equal(fact('stats.29.sacksAllowed').value, 1)
    assert.match(fact('stats.29.sacks').statement, /not sacks allowed/)
    const missing = buildAnalyticsSnapshot('team_analysis', { season: 2026, teamId: 29 }, {
      ...source, teamStats: source.teamStats.map((row) => ({ ...row, sacks_yards_lost: null })),
    })
    assert.equal(fact('stats.29.sacksAllowed', missing).value, null)
  })

  it('retains supplied injury statuses, positions, and observation timestamps without claiming game-day availability', () => {
    const reported = render(output('injury.0', 'injury.1'))
    assert.match(reported, /Known player \(CB\).*reported status Questionable/)
    assert.match(reported, /injury date 2026-09-20.*last observed 2026-10-02/)
    assert.match(reported, /Unknown position, Houston: reported status Out/)
    assert.doesNotMatch(reported, /sidelined|confirmed absences|Unknown position \(LB\)/)
    assert.match(reported, /not confirmed game-time availability/)
  })

  it('derives team injury counts from supplied records without conflating statuses or unique players', () => {
    const context = buildAnalyticsSnapshot('matchup_preview', snapshot.filters, {
      ...source,
      injuries: [
        ...source.injuries,
        { ...source.injuries[0], status: 'Out' },
        { ...source.injuries[0], player_id: 12, status: null },
        { ...source.injuries[0], team_id: null },
        { ...source.injuries[0], team_id: 999 },
      ],
    })
    const before = JSON.stringify(context)
    const away = fact('injury-summary.29', context)
    const home = fact('injury-summary.26', context)
    assert.equal(away.teamId, 29)
    assert.equal(away.value, 3)
    assert.equal(away.unit, 'supplied injury records')
    assert.match(away.statement, /Dallas: 3 supplied injury records/)
    assert.match(away.statement, /Out: 1, Questionable: 1, unknown: 1/)
    assert.match(away.statement, /positions \(CB: 2, unknown: 1\)/)
    assert.match(away.statement, /not unique injured players or confirmed game-time availability/)
    assert.equal(home.value, 1)
    assert.match(home.statement, /Houston: 1 supplied injury records; reported statuses \(Out: 1\)/)
    assert(!buildAnalyticsFacts(context).facts.some((entry) => entry.id === 'injury-summary.999'))
    assert.equal(JSON.stringify(context), before)
    assert(!buildAnalyticsFacts(snapshot).facts.some((entry) => entry.metric === 'injury-summary'))
  })

  it('grounds missing and truncated injury summaries and prioritizes both teams within the catalog budget', () => {
    const context = buildAnalyticsSnapshot('matchup_preview', snapshot.filters, source, snapshot.generatedAt, {
      games: 100, teamTrends: 32, teamStatTrends: 32, injuries: 1, playerStats: 120, standings: 32,
    })
    assert.match(fact('injury-summary.29', context).statement, /1 supplied injury records.*not complete team totals/)
    assert.equal(fact('injury-summary.26', context).value, 0)
    assert.match(fact('injury-summary.26', context).statement, /no current injury records were supplied.*does not confirm.*healthy/)
    assert.match(fact('injury-summary.26', context).statement, /omitted records may include this team/)
    const empty = { ...context, currentInjuries: { total: 0, included: 0, truncated: false, items: [] } }
    for (const id of [29, 26]) assert.match(fact(`injury-summary.${id}`, empty).statement, /no current injury records/)
    const oversized = {
      ...context,
      currentInjuries: {
        ...context.currentInjuries,
        items: context.currentInjuries.items.map((injury) => ({ ...injury, description: 'x'.repeat(60_000) })),
      },
    }
    const catalog = buildAnalyticsFacts(oversized)
    assert(catalog.truncated)
    assert(catalog.facts.some((entry) => entry.id === 'injury-summary.29'))
    assert(catalog.facts.some((entry) => entry.id === 'injury-summary.26'))
    assert(JSON.stringify(catalog.facts.map(analyticsPromptFact)).length <= MAX_REPORT_FACT_CONTEXT_CHARS)
  })

  it('keeps current consensus distinct from historical closing lines and external market claims', () => {
    const reported = render(output('matchup.spread', 'matchup.total', 'game.1.lines', 'limitation.market-history'))
    assert.match(reported, /current consensus home spread for Houston: -3/)
    assert.match(reported, /historical closing home spread -3/)
    assert.match(reported, /Opening odds and line movement are unavailable/)
    assert.match(reported, /provider freshness unknown/)
    assert.doesNotMatch(reported, /Under 48.5|line moved|current closing line/)
  })

  it('preserves aggregate counts while disclosing truncated supporting game IDs', () => {
    const bounded = buildAnalyticsSnapshot('season_overview', snapshot.filters, source, snapshot.generatedAt, {
      games: 1, teamTrends: 32, teamStatTrends: 32, injuries: 50, playerStats: 120, standings: 32,
    })
    assert.match(fact('team.29.all.ats', bounded).statement, /4 appearances/)
    assert.equal(fact('team.29.all.ats', bounded).gameIds.length, 1)
    assert.match(render(output('team.29.all.ats'), bounded), /aggregate facts may cover more games/)
    assert(!buildAnalyticsFacts(bounded).facts.some((item) => item.id === 'game.1.score'))
  })

  it('bounds the catalog while retaining injury and metric facts ahead of optional location detail', () => {
    const large: AnalyticsSnapshot = {
      ...snapshot,
      teamTrends: {
        total: 32, included: 32, truncated: false,
        items: Array.from({ length: 32 }, (_, index) => {
          const trend = snapshot.teamTrends.items[0]
          assert(trend.locationSplits)
          const teamId = index + 100
          return {
            ...trend, teamId,
            locationSplits: {
              home: { ...trend.locationSplits.home, teamId },
              away: { ...trend.locationSplits.away, teamId },
            },
          }
        }),
      },
      teamStatTrends: {
        total: 32, included: 32, truncated: false,
        items: Array.from({ length: 32 }, (_, index) => ({ ...snapshot.teamStatTrends.items[0], teamId: index + 100 })),
      },
    }
    const catalog = buildAnalyticsFacts(large)
    assert(catalog.facts.length <= 600)
    assert(JSON.stringify(catalog.facts.map(analyticsPromptFact)).length <= MAX_REPORT_FACT_CONTEXT_CHARS)
    assert(catalog.truncated)
    assert(catalog.facts.some((entry) => entry.id === 'injury.0'))
    assert(catalog.facts.some((entry) => entry.id === 'stats.131.turnovers'))
    assert.match(render(output('injury.0'), large), /Fact catalog bounded to/)
    const omitted = Array.from({ length: 32 }, (_, index) => `team.${index + 100}.away.pointsFor`)
      .find((id) => !catalog.facts.some((entry) => entry.id === id))!
    assert.throws(() => render(output(omitted), large), /outside the supplied report catalog/)
  })

  it('keeps legacy reports immutable and identifies unavailable scope and sample coverage', () => {
    const legacy: AnalyticsSnapshot = {
      ...snapshot, schemaVersion: 1, evidenceScope: undefined,
      teamStatTrends: {
        ...snapshot.teamStatTrends,
        items: snapshot.teamStatTrends.items.map((trend) => ({ ...trend, metricSamples: undefined, averageSacksAllowed: undefined })),
      },
    }
    const before = JSON.stringify(legacy)
    const reported = render(output('stats.29.turnovers'), legacy)
    assert.match(reported, /Legacy report/)
    assert.match(reported, /effective history scope was not recorded/)
    assert.match(reported, /field-specific sample coverage unknown/)
    assert.equal(fact('stats.29.sacksAllowed', legacy).value, null)
    assert.equal(JSON.stringify(legacy), before)
    assert(analyticsProvenance(legacy).some((note) => note.includes('new analysis')))
  })

})

describe('validated report selections', () => {
  it('cleans new matchup follow-ups while preserving exact values, source limitations, and the underlying snapshot', () => {
    const context: AnalyticsSnapshot = { ...snapshot, preset: 'matchup_preview' }
    const before = JSON.stringify(context)
    const reported = render(output(
      'matchup.identity', 'game.1.score', 'game.1.lines', 'injury.0', 'stats.29.turnovers', 'stats.29.passYards',
    ), context)
    assert.match(reported, /Dallas \(away\) at Houston \(home\); 2026, Regular Season, Week 4/)
    assert.match(reported, /Dallas at Houston on 2026-09-01/)
    assert.match(reported, /Known player \(CB\)/)
    assert.match(reported, /average turnovers committed \(not turnover differential\) 0.75 per observed game/)
    assert.match(reported, /average passing yards 200 per observed game/)
    assert.match(reported, /## Scope and limitations/)
    assert.match(reported, /not confirmed game-time availability/)
    assert.doesNotMatch(reported, /teamId|playerId|gameIds?|Game \d+|team 29|team 26|21570|Evidence:|Sources:|Model check:|sum 3|eligible games|stats\.29|Unknown matchup/)
    assert.match(reported, /Dallas at Houston on 2026-09-01, 2026-09-01, Regular Season/)
    assert.doesNotMatch(reported.split('## Team statistics')[1].split('## Reported injuries')[0], /observations|eligible|sum/)
    assert.equal(JSON.stringify(context), before)
  })

  it('uses names in new matchup comparison tables without changing the calculated difference', () => {
    const context: AnalyticsSnapshot = {
      ...snapshot, preset: 'matchup_preview',
      teamTrends: {
        ...snapshot.teamTrends,
        items: snapshot.teamTrends.items.map((trend) =>
          trend.teamId === 26 ? { ...trend, averagePointsFor: 20 } : trend),
      },
    }
    const reported = render(JSON.stringify({ observations: [{
      kind: 'comparison', leftFactId: 'team.29.all.pointsFor', rightFactId: 'team.26.all.pointsFor',
    }] }), context)
    assert.match(reported, /\| Team \| Supplied value \| Unit \|/)
    assert.match(reported, /\| Dallas \| 24 \| points \|/)
    assert.match(reported, /\| Houston \| 20 \| points \|/)
    assert.match(reported, /4 points higher/)
    assert.doesNotMatch(reported, /teamId|gameIds|Evidence:/)
  })

  it('groups selected facts into Markdown sections without adding unselected facts or empty sections', () => {
    const reported = render(output('team.29.all.totals', 'matchup.total', 'team.29.all.ats'))
    assert(reported.startsWith('# Validated factual report\n\n'))
    assert.match(reported, /## Matchup and current odds\n\n- Stored current consensus total/)
    assert.match(reported, /## Team trends\n\n- Dallas/)
    assert(reported.indexOf('Stored current consensus total') < reported.indexOf('Dallas, all locations'))
    assert(reported.indexOf('totals (overs-unders-pushes)') < reported.indexOf('ATS (wins-losses-pushes)'))
    assert.match(reported, /\*\*Evidence:\*\* teamId 29; gameIds/)
    assert.match(reported, /## Source scope and limitations\n\n-/)
    assert.match(reported, /\*\*Interpretation:\*\*/)
    assert.doesNotMatch(reported, /## Team statistics|## Reported injuries|## Player statistics/)
    assert.doesNotMatch(reported, /Known player|average sacks allowed/)
  })

  it('retains source disclosures when only a limitation is selected', () => {
    const reported = render(output('limitation.market-history'))
    assert.match(reported, /^# Validated factual report\n\n## Source scope and limitations/)
    assert.match(reported, /Opening odds and line movement are unavailable/)
    assert.match(reported, /Provider freshness and opening-line movement are not established/)
    assert.doesNotMatch(reported, /## Matchup and current odds|## Team trends/)
  })

  it('renders a comparison table with unchanged fact values and a calculated difference', () => {
    const context: AnalyticsSnapshot = {
      ...snapshot,
      teamTrends: {
        ...snapshot.teamTrends,
        items: snapshot.teamTrends.items.map((trend) =>
          trend.teamId === 26 ? { ...trend, averagePointsFor: 20 } : trend),
      },
    }
    const reported = render(JSON.stringify({ observations: [{
      kind: 'comparison', leftFactId: 'team.29.all.pointsFor', rightFactId: 'team.26.all.pointsFor',
    }] }), context)
    assert.match(reported, /\| Source \| Supplied value \| Unit \|/)
    assert.match(reported, /\| First: teamId 29 \| 24 \| points \|/)
    assert.match(reported, /\| Second: teamId 26 \| 20 \| points \|/)
    assert.match(reported, /\*\*Difference:\*\* The first supplied value is 4 points higher/)
    assert.match(reported, /Dallas.*average points scored 24 across 4 games/)
    assert.match(reported, /Houston.*average points scored 20 across 4 games/)
    assert.match(reported, /descriptive, not a predictive conclusion/)
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: reported })))
    try {
      const report = dom.window.document.querySelector('.analytics-report-content')
      assert.equal(report?.querySelectorAll('tbody tr').length, 2)
      assert.equal(report?.querySelector('tbody td')?.textContent, 'First: teamId 29')
      assert.equal(report?.querySelector('tbody td:nth-child(2)')?.textContent, '24')
      assert.match(report?.textContent ?? '', /4 points higher/)
    } finally {
      dom.window.close()
    }
  })

  it('constrains generation to valid reference IDs, exact fields, and the same observation cap as validation', () => {
    const schema = buildAnalyticsReportSchema(snapshot)
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['observations'])
    assert.equal(schema.properties.observations.minItems, 1)
    assert.equal(schema.properties.observations.maxItems, 40)
    const variants = schema.properties.observations.items.anyOf
    assert(variants.every((variant) => variant.additionalProperties === false))
    assert.deepEqual(variants[0].properties.factId?.enum, buildAnalyticsFacts(snapshot).facts.map((fact) => fact.id))
    assert(!JSON.stringify(schema).includes('game.999.score'))
    const empty = buildAnalyticsSnapshot('season_overview', { season: 2026 }, {
      games: [], teamStats: [], playerStats: [], standings: [], injuries: [], players: [],
    })
    assert.equal(buildAnalyticsReportSchema(empty).properties.observations.items.anyOf.length, 1)
  })

  it('renders comparable team metrics with application-calculated differences and evidence IDs', () => {
    const reported = render(JSON.stringify({ observations: [{
      kind: 'comparison', leftFactId: 'team.29.all.pointsFor', rightFactId: 'team.26.all.pointsFor',
    }] }))
    assert.match(reported, /teamId 29/)
    assert.match(reported, /teamId 26/)
    assert.match(reported, /equal to the second/)
    assert.match(reported, /descriptive, not a predictive conclusion/)
  })

  it('rejects fabricated values, entities, templates, incompatible comparisons, and malformed output', () => {
    for (const content of [
      'Dallas is 2-2 ATS.',
      '{"observations":[]}',
      output('game.999.score'),
      JSON.stringify({ observations: [{ kind: 'fact', factId: 'sample.spread', value: 99 }] }),
      JSON.stringify({ observations: [{ kind: 'fact', factId: 'sample.spread', teamId: 29 }] }),
      JSON.stringify({ observations: [{ kind: 'hypothesis', factId: 'sample.spread' }] }),
      JSON.stringify({ observations: [{ kind: 'comparison', leftFactId: 'team.29.all.pointsFor', rightFactId: 'team.26.away.pointsFor' }] }),
      JSON.stringify({ observations: [{ kind: 'comparison', leftFactId: 'stats.29.sacks', rightFactId: 'stats.29.sacksAllowed' }] }),
      JSON.stringify({ observations: [{ kind: 'comparison', leftFactId: 'matchup.spread', rightFactId: 'matchup.total' }] }),
      output('sample.spread', 'sample.spread'),
      output(...Array.from({ length: 41 }, () => 'sample.spread')),
      JSON.stringify({ observations: [{ kind: 'fact', factId: 'sample.spread' }], summary: 'invented' }),
    ]) assert.throws(() => render(content), AnalyticsReportError)
    for (const reason of ['length', null, 'tool_calls']) {
      assert.throws(() => renderAnalyticsReport(output('sample.spread'), snapshot, reason), /did not finish normally/)
    }
  })

  it('uses the same fact boundary for every Analytics preset', () => {
    for (const preset of ['season_overview', 'team_analysis', 'game_review', 'matchup_preview', 'trend_comparison'] as const) {
      const context = { ...snapshot, preset }
      assert.match(render(output('sample.spread'), context), /^# Validated factual report\n\n## Selected-game results/)
      const selectedTeam = render(output('team.29.all.ats'), context)
      if (preset === 'matchup_preview') assert.doesNotMatch(selectedTeam, /teamId|gameIds|Evidence:/)
      else assert.match(selectedTeam, /Evidence:\*\* teamId 29; gameIds/)
      assert.throws(() => render('Unvalidated prose.', context), AnalyticsReportError)
    }
  })
})
