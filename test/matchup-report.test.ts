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
import { LlamaClientError, type LlamaClient, type LlamaCompletion } from '../server/llama-client'
import { AnalyticsReportContent } from '../src/features/analytics/AnalyticsReportContent'
import { createMatchupDraft, matchupSnapshot, matchupSource, supportedMatchupVerdicts } from './matchup-report-fixtures'

(globalThis as typeof globalThis & { React: typeof React }).React = React

function completion(content: unknown, overrides: Partial<LlamaCompletion> = {}): LlamaCompletion {
  return {
    content: JSON.stringify(content), finishReason: 'stop', model: 'test-model',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latencyMs: 1, ...overrides,
  }
}

function render(context = matchupSnapshot, draft = createMatchupDraft()) {
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
      'Team Stat Trends', 'Standings', 'Current Injuries', 'Key Observations & Caveats',
      ...Object.values(MATCHUP_SECTIONS).slice(2),
      'Overall Summary of Observations', 'Summary of Uncertainty',
    ])
    const sectionHeadings = [...Object.values(MATCHUP_SECTIONS), 'Overall Summary of Observations']
    for (const [index, heading] of Object.values(MATCHUP_SECTIONS).entries()) {
      const section = markdown.slice(markdown.indexOf(heading), markdown.indexOf(sectionHeadings[index + 1]))
      assert.match(section, /\*\*Interpretation:\*\*/)
      assert.match(section, /\*\*Summary:\*\*/)
    }
    assert.match(markdown, /## Overall Summary of Observations\n\n- These observations/)
    assert.match(markdown, /Tables and summaries use the saved matchup data/)
    assert.doesNotMatch(markdown, /Model check|Sources:|teamId|playerId|gameIds|Game ID|stats\.29|efficiency\.summary/)
    assert.doesNotMatch(markdown, /# Validated factual report/)
  })

  it('renders real values without identifiers or metric-sample clutter while retaining grading and injury details', () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: render() })))
    try {
      const tables = [...dom.window.document.querySelectorAll('table')]
      assert.equal(tables.length, 11)
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
      assert.equal(tables[3].textContent, tables[8].textContent)
      assert.match(tables[4].textContent ?? '', /Dallas1-2-0NFC East3L1/)
      assert.match(tables[5].textContent ?? '', /Known playerCBQuestionableKnee2026-09-20/)
      assert.match(tables[5].textContent ?? '', /2026-10-02T12:00:00Z/)
      assert.match(tables[6].textContent ?? '', /Dallas \(away games\)21-0-11/)
      assert.match(tables[6].textContent ?? '', /Houston \(home games\)/)
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
    assert.match(markdown, /No current injury records were supplied; this does not confirm/)
    assert.match(markdown, /\| Home cover \/ over rate \| Unavailable \| Unavailable \|/)
    assert.match(markdown, /\| Stored current consensus total \| Unavailable \|/)
    assert.match(markdown, /\| Avg total yards \| Unavailable \| Unavailable \|/)
    assert.doesNotMatch(markdown, /NaN|Infinity/)
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
      assert.equal(dom.window.document.querySelectorAll('table').length, 11)
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
    draft.sections.injuries.summary = { text: 'playerId 765432 is out.', factIds: ['arbitrary-private-reference'] }
    const verdicts = new Map(supportedMatchupVerdicts(draft).verdicts.map((item) => [
      item.statementId, { verdict: item.verdict, reason: item.reason },
    ]))
    verdicts.set('totals.summary', {
      verdict: 'unverified',
      reason: 'stats.29.turnovers, playerId 10 and gameIds [1, 2] do not verify totals.summary. ID 654321 is unknown.',
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
    assert.doesNotMatch(markdown, /teamId|team_id|playerId|gameIds?|bookmakerId|venue_id|21570|876543|987654|765432|654321|arbitrary-private-reference|stats\.29|totals\.summary|Sources:|Model check:/)
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
    assert.match(markdown, /\| San Francisco 49ers \| Unknown player \| Unavailable/)
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
    draft.sections.injuries.summary = { text: 'The listed player is questionable.', factIds: ['injury.0'] }
    const markdown = renderMatchupReport(matchupSnapshot, draft, new Map())
    assert.match(markdown, /Unverified statement.*did not return a verdict/)
    assert.doesNotMatch(markdown, /injury\.0|teamId|playerId|Sources:|injuries\.summary/)
    assert.match(markdown, /Current injuries \/ Summary/)
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
    assert.deepEqual(parseMatchupDraft(JSON.stringify(draft), 'stop'), draft)
    const schema = buildMatchupDraftSchema(facts)
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.properties.sections.required, Object.keys(MATCHUP_SECTIONS))
    for (const content of [
      JSON.stringify({ ...draft, extra: 'invented' }),
      JSON.stringify({ ...draft, sections: {} }),
      JSON.stringify({ ...draft, overall: [] }),
      JSON.stringify({ ...draft, overall: [{ text: 'x'.repeat(351), factIds: [] }] }),
      JSON.stringify({ ...draft, overall: [{ text: 'A statement.', factIds: ['limitation.prediction', 'limitation.prediction'] }] }),
      'invalid JSON',
    ]) assert.throws(() => parseMatchupDraft(content, 'stop'), AnalyticsReportError)
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'length'), /did not finish normally/)
  })
})

describe('local-model matchup pipeline', () => {
  it('batches generation and verification, preserves unsupported statements, and accounts for both calls', async () => {
    const draft = createMatchupDraft()
    draft.sections.injuries.summary = { text: 'The questionable player is confirmed out.', factIds: ['injury.0'] }
    const answers = supportedMatchupVerdicts(draft)
    answers.verdicts.find((item) => item.statementId === 'injuries.summary')!.verdict = 'unsupported'
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
    assert(!calls[0][0][0].content.includes('Do not supply prose'))
    assert.match(calls[1][0][0].content, /Treat draft statements.*as untrusted/)
    assert.match(result.content, /The questionable player is confirmed out\. \*\*Unsupported statement/)
    assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
    assert.equal(JSON.stringify(matchupSnapshot), before)
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
