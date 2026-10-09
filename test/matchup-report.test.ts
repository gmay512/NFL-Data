import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { buildAnalyticsSnapshot, type AnalyticsSnapshot } from '../server/analytics-core'
import { buildAnalyticsFacts } from '../server/analytics-facts'
import {
  MATCHUP_SECTIONS, buildMatchupDraftSchema, checkMatchupStatement,
  generateMatchupReport, parseMatchupDraft, renderMatchupReport,
} from '../server/matchup-report'
import { AnalyticsReportError } from '../server/analytics-report'
import { LlamaClientError, LlamaClient, getLlamaConfig, type LlamaCompletion } from '../server/llama-client'
import { AnalyticsReportContent } from '../src/features/analytics/AnalyticsReportContent'
import { createMatchupDraft, matchupSnapshot, matchupSource, supportedMatchupVerdicts } from './matchup-report-fixtures'

(globalThis as typeof globalThis & { React: typeof React }).React = React

function completion(content: unknown, overrides: Partial<LlamaCompletion> = {}): LlamaCompletion {
  return {
    content: JSON.stringify(content), finishReason: 'stop', model: 'test-model',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latencyMs: 1, ...overrides,
  }
}

function render(context = matchupSnapshot, draft = createMatchupDraft(context)) {
  const verdicts = new Map(supportedMatchupVerdicts(draft).verdicts.map((item) => [
    item.statementId, { verdict: item.verdict, reason: item.reason },
  ]))
  return renderMatchupReport(context, draft, verdicts)
}

describe('fixed pregame matchup layout', () => {
  it('includes the attachment order, five numbered sections, interpretations, summaries, and overall observations', () => {
    const markdown = render()
    const headings = [...markdown.matchAll(/^#{1,3} (.+)$/gm)].map((match) => match[1])
    assert.deepEqual(headings, [
      'Pregame Matchup Analysis', 'Matchup Summary: Dallas at Houston',
      'Summary of Prior Performance', 'General ATS & Totals Trends', 'Team-Specific ATS Trends',
      'Team Stat Trends', 'Standings', 'Current Injuries', 'Dallas', 'Houston', 'Key Observations & Caveats',
      ...Object.values(MATCHUP_SECTIONS).slice(2),
      'Overall Summary of Observations', 'Summary of Uncertainty',
    ])
    const sectionHeadings = [...Object.values(MATCHUP_SECTIONS), 'Overall Summary of Observations']
    for (const [index, heading] of Object.values(MATCHUP_SECTIONS).entries()) {
      if (heading === MATCHUP_SECTIONS.injuries) continue
      const section = markdown.slice(markdown.indexOf(heading), markdown.indexOf(sectionHeadings[index + 1]))
      assert.match(section, /\*\*Interpretation:\*\*/)
      assert.match(section, /\*\*Summary:\*\*/)
    }
    assert.match(markdown, /## Overall Summary of Observations\n\n- These observations/)
    assert.match(markdown, /Tables and summaries use the saved matchup data/)
    assert.doesNotMatch(markdown, /Model check|Sources:|teamId|playerId|gameIds|Game ID|stats\.29|efficiency\.summary/)
    assert.doesNotMatch(markdown, /# Validated factual report/)
  })

  it('renders real values and team injury bullets without identifiers or a detailed injury table', () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: render() })))
    try {
      const tables = [...dom.window.document.querySelectorAll('table')]
      assert.equal(tables.length, 10)
      assert.equal([...tables[0].querySelectorAll('tbody tr')][2].textContent, 'HomeHouston')
      assert.match(tables[0].textContent ?? '', /Not Started/)
      assert.match(tables[1].textContent ?? '', /Decisions \(pushes excluded\)22/)
      assert.match(tables[1].textContent ?? '', /Pushes11/)
      assert.match(tables[1].textContent ?? '', /Ungraded11/)
      assert.match(tables[1].textContent ?? '', /0%50%/)
      assert.match(tables[2].textContent ?? '', /Dallas \(all locations\)41-1-12150%/)
      assert.match(tables[2].textContent ?? '', /Houston \(all locations\)/)
      assert.equal(tables[3].querySelectorAll('th')[1].textContent, 'Dallas')
      assert.deepEqual([...tables[3].querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent)), [
        ['Avg total yards', '300', 'Unavailable'],
        ['Avg passing yards', '200', 'Unavailable'],
        ['Avg rushing yards', '100', 'Unavailable'],
        ['Avg turnovers committed', '0.75', 'Unavailable'],
        ['Avg sacks allowed', '1', 'Unavailable'],
      ])
      assert.doesNotMatch(tables[3].textContent ?? '', /observations|eligible|sum|gameId|coverage/)
      assert.equal(tables[3].textContent, tables[7].textContent)
      assert.match(tables[4].textContent ?? '', /Dallas1-2-0NFC East3L1/)
      assert.match(tables[5].textContent ?? '', /Dallas \(away games\)21-0-11/)
      assert.match(tables[5].textContent ?? '', /Houston \(home games\)/)
      const injuries = render().split('## Current Injuries\n\n')[1].split('## Key Observations & Caveats')[0]
      assert.match(injuries, /### Dallas\n\n- Dallas has 1 supplied injury records; Known player \(CB\) is reported Questionable/)
      assert.match(injuries, /### Houston\n\n- No current injury records were supplied for Houston/)
      assert.doesNotMatch(injuries, /\||First observed|Last observed|Injury date|2026-09-20|2026-10-02|\*\*Interpretation:|\*\*Summary:/)
      assert.match(dom.window.document.body.textContent ?? '', /not confirmed game-time availability/)
      assert.match(dom.window.document.body.textContent ?? '', /not necessarily league-wide/)
      assert.match(dom.window.document.body.textContent ?? '', /offensive sacks\/yardage/)
    } finally {
      dom.window.close()
    }
  })

  it('retains every section when no historical, market, standing, or injury evidence exists', () => {
    const empty = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource, games: [], teamStats: [], standings: [], injuries: [], players: [],
      targetMatchup: { ...matchupSource.targetMatchup!, currentConsensusOdds: { homeSpread: null, total: null } },
    })
    const markdown = render(empty)
    for (const heading of Object.values(MATCHUP_SECTIONS)) assert(markdown.includes(heading))
    assert.match(markdown, /No current injury records were supplied for Dallas; this does not confirm/)
    assert.match(markdown, /No current injury records were supplied for Houston; this does not confirm/)
    assert.match(markdown, /\| Home cover \/ over rate \| Unavailable \| Unavailable \|/)
    assert.match(markdown, /\| Stored current consensus total \| Unavailable \|/)
    assert.match(markdown, /\| Avg total yards \| Unavailable \| Unavailable \|/)
    assert.doesNotMatch(markdown, /NaN|Infinity/)
  })

  it('renders at most three list items per named team, including grouped counts and notable players', () => {
    const context = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource,
      injuries: [
        ...matchupSource.injuries,
        { ...matchupSource.injuries[0], team_id: 26, status: 'Out' },
      ],
    })
    const draft = createMatchupDraft(context)
    for (const side of ['away', 'home'] as const) {
      const team = context.targetMatchup![`${side}Team`]
      draft.sections.injuries[side].push(
        { text: 'The supplied records cover the CB position.', factIds: [`injury-summary.${team.id}`] },
        { text: 'Availability is not confirmed for game time.', factIds: [`injury-summary.${team.id}`] },
      )
    }
    const injuries = render(context, draft).split('## Current Injuries\n\n')[1].split('## Key Observations & Caveats')[0]
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: injuries })))
    try {
      assert.deepEqual([...dom.window.document.querySelectorAll('h5')].map((heading) => heading.textContent), ['Dallas', 'Houston'])
      assert.deepEqual([...dom.window.document.querySelectorAll('ul')].map((list) => list.querySelectorAll('li').length), [3, 3])
      assert.equal(dom.window.document.querySelectorAll('table').length, 0)
      assert.match(dom.window.document.querySelectorAll('ul')[0].textContent ?? '', /Dallas has 1 supplied injury records.*Known player.*Questionable/)
      assert.match(dom.window.document.querySelectorAll('ul')[1].textContent ?? '', /Houston has 1 supplied injury records.*Known player.*Out/)
    } finally {
      dom.window.close()
    }
  })

  it('discloses truncation, stage filters, legacy coverage, and immutable snapshots', () => {
    const bounded = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource, evidenceScope: { ...matchupSource.evidenceScope!, stage: 'Post Season', excludedStage: 'Pre Season' },
    }, matchupSnapshot.generatedAt, { games: 1, teamTrends: 32, teamStatTrends: 32, standings: 32, injuries: 0, playerStats: 120 })
    const legacy: AnalyticsSnapshot = {
      ...bounded, schemaVersion: 1, evidenceScope: undefined,
      teamStatTrends: { ...bounded.teamStatTrends, items: bounded.teamStatTrends.items.map((item) => ({
        ...item, metricSamples: undefined, averageSacksAllowed: undefined,
      })) },
    }
    const before = JSON.stringify(legacy)
    assert.match(render(bounded), /2026 Post Season/)
    assert.match(render(bounded), /1 of 4 supplied; truncated/)
    assert.match(render(bounded), /aggregate facts may cover more games/)
    const markdown = render(legacy)
    assert.match(markdown, /Legacy report/)
    assert.match(markdown, /effective history scope was not recorded/)
    assert.match(markdown, /\| Avg sacks allowed \| Unavailable \| Unavailable \|/)
    assert.equal(JSON.stringify(legacy), before)
  })

  it('escapes source and narrative markup without adding fabricated report sections or HTML', () => {
    const name = '**Dallas** | [fake](javascript:bad)\n## Invented <script>bad</script> &copy;'
    const draft = createMatchupDraft()
    draft.sections.oddsContext.summary.text = '[Bad](javascript:alert(1)) <img src="https://example.com/pixel"> **Fake** | header'
    const context = {
      ...matchupSnapshot,
      targetMatchup: { ...matchupSnapshot.targetMatchup!, awayTeam: { id: 29, name } },
    }
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: render(context, draft) })))
    try {
      assert.equal(dom.window.document.querySelectorAll('script, img').length, 0)
      assert([...dom.window.document.querySelectorAll('a')].every((link) => link.href.startsWith('https://example.com/')))
      assert.equal(dom.window.document.querySelectorAll('table').length, 10)
      assert.match(dom.window.document.body.textContent ?? '', /\*\*Dallas\*\* \| \[fake\]/)
      assert.match(dom.window.document.body.textContent ?? '', /\*\*Fake\*\*/)
      assert(![...dom.window.document.querySelectorAll('h4, h5')].some((heading) => heading.textContent === 'Invented'))
    } finally {
      dom.window.close()
    }
  })

  it('removes references from narrative, reasons, and source warnings without stripping legitimate numbers', () => {
    const draft = createMatchupDraft()
    draft.sections.oddsContext.summary = {
      text: 'teamId 29 plays team_id: 26 in gameId 21570 during 2026 Week 4.',
      factIds: ['matchup.identity'],
    }
    draft.sections.efficiency.summary = {
      text: 'bookmakerId 876543 and venue_id: 987654 are internal references.',
      factIds: ['stats.29.turnovers'],
    }
    draft.sections.injuries.away[0] = { text: 'playerId 765432 is out.', factIds: ['arbitrary-private-reference'] }
    const verdicts = new Map(supportedMatchupVerdicts(draft).verdicts.map((item) => [
      item.statementId, { verdict: item.verdict, reason: item.reason },
    ]))
    verdicts.set('totals.summary', {
      verdict: 'unverified',
      reason: 'stats.29.turnovers, playerId 10 and gameIds [1, 2] do not verify totals.summary. ID 654321 is unknown.',
    })
    verdicts.set('injuries.home.0', {
      verdict: 'unverified', reason: 'injury-summary.29 does not establish injuries.away.0.',
    })
    const before = JSON.stringify(matchupSnapshot)
    const markdown = renderMatchupReport(matchupSnapshot, draft, verdicts)
    assert.match(markdown, /Dallas plays Houston in Dallas at Houston on 2026-10-04 during 2026 Week 4/)
    assert.match(markdown, /Dallas turnovers committed/)
    assert.match(markdown, /Known player/)
    assert.match(markdown, /Houston at Dallas on 2026-09-04, Dallas: unrecognized offensive sacks/)
    assert.match(markdown, /Unsupported statement/)
    assert.match(markdown, /Unverified statement/)
    assert.match(markdown, /Offensive efficiency and turnovers \/ Summary/)
    assert.match(markdown, /Dallas supplied injury summary does not establish Current injuries \/ Away team \/ Observation 1/)
    assert.doesNotMatch(markdown, /teamId|team_id|playerId|gameIds?|bookmakerId|venue_id|21570|876543|987654|765432|654321|arbitrary-private-reference|stats\.29|totals\.summary|injury-summary\.29|injuries\.away\.0|Sources:|Model check:/)
    assert.equal(JSON.stringify(matchupSnapshot), before)
  })

  it('shows unknown entities without their fallback IDs and keeps zero statistics', () => {
    const context = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource, players: [],
      targetMatchup: { ...matchupSource.targetMatchup!, awayTeam: { id: 29, name: 'San Francisco 49ers' } },
      teamStats: matchupSource.teamStats.map((row) => ({ ...row, turnovers_total: 0, pass_yards: 29, yards_total: 21570 })),
    }, matchupSnapshot.generatedAt)
    const markdown = render(context)
    assert.match(markdown, /Matchup Summary: San Francisco 49ers at Houston/)
    assert.match(markdown, /\| Avg turnovers committed \| 0 \| Unavailable \|/)
    assert.match(markdown, /\| Avg passing yards \| 29 \| Unavailable \|/)
    assert.match(markdown, /\| Avg total yards \| 21570 \| Unavailable \|/)
    assert.match(markdown, /Unknown player \(unknown position\) is reported Questionable/)
    assert.doesNotMatch(markdown, /Player 10|playerId|teamId|Game ID/)
    const tableBody = markdown.split('### Team Stat Trends\n\n')[1].split('\n\n### Standings')[0]
    assert.doesNotMatch(tableBody, /observations|eligible|sum |gameId|coverage/)
  })
})

describe('matchup narrative checks', () => {
  const facts = buildAnalyticsFacts(matchupSnapshot).facts
  const check = (text: string, factIds: string[], section: keyof typeof MATCHUP_SECTIONS = 'efficiency') =>
    checkMatchupStatement({ id: `${section}.summary`, section, text, factIds }, facts)

  it('checks references, values, identities, and section scopes independently of verifier verdicts', () => {
    assert.equal(check('Dallas averaged 0.75 turnovers committed.', ['stats.29.turnovers']), null)
    assert.equal(check('Dallas averaged 8.5 turnovers.', ['stats.29.turnovers'])?.verdict, 'unsupported')
    assert.match(check('Team 999 is in the sample.', ['stats.29.turnovers'])?.reason ?? '', /not supported/)
    assert.match(check('A supplied fact.', ['stats.999.turnovers'])?.reason ?? '', /outside the supplied catalog/)
    assert.match(check('The sample is limited.', ['injury.0'])?.reason ?? '', /section's scope/)
    assert.equal(check('A model guess.', [])?.verdict, 'unverified')
    assert.equal(check('Team 29 has the supplied turnovers.', ['stats.29.turnovers']), null)
    assert.equal(check('Team 29 is the away team.', ['matchup.identity'], 'oddsContext'), null)
    assert.equal(check('The stored home spread is -3.', ['matchup.spread'], 'oddsContext'), null)
    assert.equal(check('The stored home spread is +3.', ['matchup.spread'], 'oddsContext')?.verdict, 'unsupported')
    const draft = createMatchupDraft()
    draft.sections.efficiency.summary = { text: 'Dallas averaged 8.5 turnovers.', factIds: ['stats.29.turnovers'] }
    assert.match(render(matchupSnapshot, draft), /Unsupported statement.*numeric claim is not supplied/)
    assert.match(render(matchupSnapshot, draft), /Dallas averaged 8\.5 turnovers/)
    assert.match(render(matchupSnapshot, draft), /1 unsupported and 0 unverified/)
  })

  it('checks injury counts and prevents cross-team or unknown-team evidence from supporting a team bullet', () => {
    const item = {
      id: 'injuries.home.0', section: 'injuries' as const, teamId: 26,
      text: 'The team has a questionable player.', factIds: ['injury.0'],
    }
    assert.match(checkMatchupStatement(item, facts)?.reason ?? '', /this team's injury summary/)
    assert.equal(checkMatchupStatement({ ...item, factIds: ['injury-summary.29'] }, facts)?.verdict, 'unsupported')
    assert.equal(checkMatchupStatement({ ...item, factIds: ['injury-summary.26'], text: 'No records were supplied for Houston.' }, facts), null)
    assert.equal(checkMatchupStatement({
      ...item, teamId: 29, text: 'Dallas has 8 supplied injury records.', factIds: ['injury-summary.29'],
    }, facts)?.verdict, 'unsupported')
    assert.equal(checkMatchupStatement({
      ...item, teamId: 29, text: 'Dallas has 1 supplied injury record.', factIds: ['injury-summary.29'],
    }, facts), null)
    const unknown = facts.map((fact) => fact.id === 'injury.0' ? { ...fact, teamId: undefined } : fact)
    assert.equal(checkMatchupStatement({ ...item, teamId: 29 }, unknown)?.verdict, 'unsupported')
    const draft = createMatchupDraft()
    draft.sections.injuries.home[0] = { text: item.text, factIds: item.factIds }
    assert.match(render(matchupSnapshot, draft), /questionable player.*Unsupported statement.*this team's injury summary/)
  })

  it('allows only differences from finite, compatible metric comparisons', () => {
    const context = {
      ...matchupSnapshot, teamTrends: {
        ...matchupSnapshot.teamTrends,
        items: matchupSnapshot.teamTrends.items.map((team) => team.teamId === 26 ? { ...team, averagePointsFor: 20 } : team),
      },
    }
    const entries = buildAnalyticsFacts(context).facts
    assert.equal(checkMatchupStatement({
      id: 'totals.summary', section: 'totals', text: 'Dallas averaged 4 points more than Houston.',
      factIds: ['team.29.all.pointsFor', 'team.26.all.pointsFor'],
    }, entries), null)
    assert.equal(check('The difference is 12.5.', ['stats.29.turnovers', 'stats.29.sacksAllowed'])?.verdict, 'unsupported')
  })

  it('preserves missing verifier verdicts as unverified without exposing sources', () => {
    const draft = createMatchupDraft()
    draft.sections.injuries.away[0] = { text: 'The listed player is questionable.', factIds: ['injury.0'] }
    const markdown = renderMatchupReport(matchupSnapshot, draft, new Map())
    assert.match(markdown, /Unverified statement.*did not return a verdict/)
    assert.doesNotMatch(markdown, /injury\.0|teamId|playerId|Sources:|injuries\.away\.0/)
    assert.match(markdown, /Current injuries \/ Away team \/ Observation 1/)
    assert.match(markdown, /0 unsupported and 15 unverified/)
  })

  it('does not turn verifier explanations into new, unchecked supported narrative claims', () => {
    const draft = createMatchupDraft()
    const verdicts = new Map(supportedMatchupVerdicts(draft).verdicts.map((item) => [
      item.statementId, { verdict: item.verdict, reason: 'Invented unchecked explanation claiming a guaranteed win.' },
    ]))
    const markdown = renderMatchupReport(matchupSnapshot, draft, verdicts)
    assert.doesNotMatch(markdown, /Invented unchecked explanation/)
    assert.doesNotMatch(markdown, /Model check|Supported by the local verifier/)
  })

  it('requires all narrative slots, exact fields, bounded text, and a completed draft', () => {
    const draft = createMatchupDraft()
    assert.deepEqual(parseMatchupDraft(JSON.stringify(draft), 'stop', matchupSnapshot), draft)
    const schema = buildMatchupDraftSchema(facts, matchupSnapshot)
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.properties.sections.required, Object.keys(MATCHUP_SECTIONS))
    for (const content of [
      JSON.stringify({ ...draft, extra: 'invented' }),
      JSON.stringify({ ...draft, sections: {} }),
      JSON.stringify({ ...draft, overall: [] }),
      JSON.stringify({ ...draft, overall: [{ text: 'x'.repeat(351), factIds: [] }] }),
      JSON.stringify({ ...draft, overall: [{ text: 'A statement.', factIds: ['limitation.prediction', 'limitation.prediction'] }] }),
      'invalid JSON',
    ]) assert.throws(() => parseMatchupDraft(content, 'stop', matchupSnapshot), AnalyticsReportError)
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'length', matchupSnapshot), /did not finish normally/)
  })

  it('enforces team bullet bounds and team-specific schema citations, with exactly one bullet for missing records', () => {
    const context = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource,
      injuries: [...matchupSource.injuries, { ...matchupSource.injuries[0], team_id: 26 }],
    })
    const draft = createMatchupDraft(context)
    const schema = buildMatchupDraftSchema(buildAnalyticsFacts(context).facts, context)
    const injuries = schema.properties.sections.properties.injuries
    assert.deepEqual(injuries.required, ['away', 'home'])
    assert.equal(injuries.additionalProperties, false)
    for (const side of ['away', 'home'] as const) {
      const entry = injuries.properties[side]
      assert.equal(entry.minItems, 1)
      assert.equal(entry.maxItems, 3)
      const ids: string[] = entry.items.properties.factIds.items.enum
      const otherTeamId = context.targetMatchup![`${side === 'away' ? 'home' : 'away'}Team`].id
      assert(!ids.includes(`injury-summary.${otherTeamId}`))
      assert(!ids.includes(side === 'away' ? 'injury.1' : 'injury.0'))
      draft.sections.injuries[side] = Array.from({ length: 3 }, () => draft.sections.injuries[side][0])
    }
    assert.deepEqual(parseMatchupDraft(JSON.stringify(draft), 'stop', context), draft)
    for (const side of ['away', 'home'] as const) {
      for (const invalid of [[], Array.from({ length: 4 }, () => draft.sections.injuries[side][0]), {}, ['bad'], [{ text: 'x'.repeat(351), factIds: [] }]]) {
        const bad = { ...draft, sections: { ...draft.sections, injuries: { ...draft.sections.injuries, [side]: invalid } } }
        assert.throws(() => parseMatchupDraft(JSON.stringify(bad), 'stop', context), AnalyticsReportError)
      }
    }
    for (const invalid of [
      { away: draft.sections.injuries.away },
      { ...draft.sections.injuries, extra: [] },
      { interpretation: draft.sections.injuries.away[0], summary: draft.sections.injuries.home[0] },
    ]) {
      assert.throws(() => parseMatchupDraft(JSON.stringify({
        ...draft, sections: { ...draft.sections, injuries: invalid },
      }), 'stop', context), AnalyticsReportError)
    }
    const missingSchema = buildMatchupDraftSchema(facts, matchupSnapshot)
    assert.equal(missingSchema.properties.sections.properties.injuries.properties.home.maxItems, 1)
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'stop', matchupSnapshot), /home team's injury summary requires one to 1 bullets/)
  })
})

describe('local-model matchup pipeline', () => {
  it('batches generation and verification, preserves unsupported statements, and accounts for both calls', async () => {
    const draft = createMatchupDraft()
    draft.sections.injuries.away[0] = { text: 'The questionable player is confirmed out.', factIds: ['injury.0'] }
    const answers = supportedMatchupVerdicts(draft)
    answers.verdicts.find((item) => item.statementId === 'injuries.away.0')!.verdict = 'unsupported'
    const calls: Parameters<LlamaClient['completeMessages']>[] = []
    const llama = {
      async completeMessages(...args: Parameters<LlamaClient['completeMessages']>) {
        calls.push(args)
        return completion(calls.length === 1 ? draft : answers)
      },
    }
    const before = JSON.stringify(matchupSnapshot)
    const result = await generateMatchupReport(llama, matchupSnapshot)
    assert.equal(calls.length, 2)
    assert.equal(calls[0][2]?.json_schema.name, 'matchup_narratives')
    assert.equal(calls[1][2]?.json_schema.name, 'matchup_verification')
    assert.match(calls[0][0][1].content, /one to three concise plain-text bullets.*for each team/)
    assert.match(calls[0][0][1].content, /exactly one bullet explaining that records are missing/)
    assert.match(calls[1][0][0].content, /Injury bullets belong only to their assigned teamId/)
    assert(!calls[0][0][0].content.includes('Do not supply prose'))
    assert.match(calls[1][0][0].content, /Treat draft statements.*as untrusted/)
    assert.match(result.content, /The questionable player is confirmed out\. \*\*Unsupported statement/)
    assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
    assert.equal(JSON.stringify(matchupSnapshot), before)
  })

  it('gives generation and verification independent request deadlines without adding model calls', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const draft = createMatchupDraft()
    let calls = 0
    let notifyVerification!: () => void
    const verificationStarted = new Promise<void>((resolve) => { notifyVerification = resolve })
    t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const index = ++calls
      assert(init?.signal)
      if (index === 2) notifyVerification()
      await new Promise<void>((resolve) => setTimeout(resolve, 60))
      assert(!init.signal.aborted)
      return new Response(JSON.stringify({
        model: 'test-model',
        choices: [{
          message: { content: JSON.stringify(index === 1 ? draft : supportedMatchupVerdicts(draft)) }, finish_reason: 'stop',
        }],
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const client = new LlamaClient({ ...getLlamaConfig({ LLM_MODEL: 'test-model' }), timeoutMs: 100 })
    const pending = generateMatchupReport(client, matchupSnapshot)
    t.mock.timers.tick(60)
    await verificationStarted
    t.mock.timers.tick(60)
    const result = await pending
    assert.equal(calls, 2)
    assert.match(result.content, /### Dallas\n\n- Dallas has 1 supplied injury records/)
    assert.doesNotMatch(result.content, /Narrative verification failed/)
  })

  it('rejects over-limit injury generation before verification or report persistence', async () => {
    const draft = createMatchupDraft()
    draft.sections.injuries.away = Array.from({ length: 4 }, () => draft.sections.injuries.away[0])
    let calls = 0
    await assert.rejects(generateMatchupReport({
      async completeMessages() { calls++; return completion(draft) },
    }, matchupSnapshot), /injury summary requires one to 3 bullets/)
    assert.equal(calls, 1)
  })
  it('saves usable narratives with explicit unverified labels when the verifier is unavailable or malformed', async () => {
    for (const failure of ['unavailable', 'malformed', 'duplicate', 'unfinished'] as const) {
      const draft = createMatchupDraft()
      let calls = 0
      const result = await generateMatchupReport({
        async completeMessages() {
          if (++calls === 1) return completion(draft)
          if (failure === 'unavailable') throw new LlamaClientError('unavailable', 'Local verifier unavailable.')
          if (failure === 'malformed') return completion({}, { content: 'not JSON' })
          if (failure === 'unfinished') return completion(supportedMatchupVerdicts(draft), { finishReason: 'length' })
          const answers = supportedMatchupVerdicts(draft)
          answers.verdicts[1] = answers.verdicts[0]
          return completion(answers)
        },
      }, matchupSnapshot)
      assert.match(result.content, /0 unsupported and 15 unverified/)
      assert.match(result.content, /Narrative verification failed:/)
      assert.match(result.content, /## Overall Summary of Observations/)
    }
  })

  it('does not save cancelled, malformed, or unfinished generation as a report', async () => {
    const draft = createMatchupDraft()
    for (const answer of [completion({}, { content: 'not JSON' }), completion(draft, { finishReason: 'length' })]) {
      await assert.rejects(generateMatchupReport({ async completeMessages() { return answer } }, matchupSnapshot), AnalyticsReportError)
    }
    const controller = new AbortController()
    let calls = 0
    await assert.rejects(generateMatchupReport({
      async completeMessages() {
        if (++calls === 1) return completion(draft)
        controller.abort()
        throw new LlamaClientError('cancelled', 'Cancelled verification.')
      },
    }, matchupSnapshot, controller.signal), /Cancelled/)
    await assert.rejects(generateMatchupReport({
      async completeMessages() { throw new Error('Unexpected failure') },
    }, matchupSnapshot), /Unexpected failure/)
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort(new Error('Already cancelled'))
    await assert.rejects(generateMatchupReport({
      async completeMessages() { assert.fail('Generation must not start after cancellation') },
    }, matchupSnapshot, alreadyCancelled.signal), /Already cancelled/)
  })
})
