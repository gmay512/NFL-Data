import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { buildAnalyticsSnapshot } from '../server/analytics-core'
import { buildAnalyticsFacts } from '../server/analytics-facts'
import {
  MATCHUP_DISCLAIMER, MAX_MATCHUP_NARRATIVE_WORDS, buildMatchupDraftSchema, checkMatchupStatement,
  generateMatchupReport, matchupStatements, parseMatchupDraft, renderMatchupReport,
} from '../server/matchup-report'
import { AnalyticsReportError, markdownText } from '../server/analytics-report'
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
  return renderMatchupReport(context, draft, new Map(supportedMatchupVerdicts(draft).verdicts.map((item) => [
    item.statementId, { verdict: item.verdict, reason: item.reason },
  ])))
}

function withOdds(homeSpread: number | null, total: number | null) {
  return buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
    ...matchupSource, targetMatchup: { ...matchupSource.targetMatchup!, currentConsensusOdds: { homeSpread, total } },
  })
}

describe('compact matchup reports', () => {
  it('keeps the summary first, includes two predictions and one disclaimer, and removes verbose sections', () => {
    const draft = createMatchupDraft()
    const markdown = render(matchupSnapshot, draft)
    assert.deepEqual([...markdown.matchAll(/^#{1,3} (.+)$/gm)].map((match) => match[1]), [
      'Matchup Summary: Dallas at Houston', 'Predictions', 'Team Standings',
      'Key Performance Notes', 'Current Injuries', 'Dallas', 'Houston',
    ])
    assert.equal(markdown.split(MATCHUP_DISCLAIMER).length - 1, 1)
    assert(markdown.indexOf(draft.summary.text) < markdown.indexOf('## Predictions'))
    assert.match(markdown, /\| ATS \| Dallas to cover \| \\\+3 \|/)
    assert.match(markdown, /\| O\/U \| Under \| 48 \|/)
    assert.doesNotMatch(markdown, /Report basis|Narrative warnings|Unsupported statement|Unverified statement|Summary of Uncertainty|Overall Summary|Interpretation:|\*\*Summary:|Key Observations|Missing\/Ungraded/)
    assert.doesNotMatch(markdown, /Sources:|teamId|playerId|gameIds|Game ID|team\.29|injury\.0/)
    assert(matchupStatements(draft, matchupSnapshot).reduce((sum, item) => sum + item.text.split(/\s+/).length, 0) <= MAX_MATCHUP_NARRATIVE_WORDS)
  })

  it('renders only prediction and standings tables and one injury bullet per named team', () => {
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: render() })))
    try {
      const document = dom.window.document
      assert.equal(document.querySelectorAll('table').length, 2)
      assert.equal(document.querySelectorAll('table')[0].querySelectorAll('tbody tr').length, 2)
      assert.match(document.querySelectorAll('table')[1].textContent ?? '', /Dallas1-2-03/)
      assert.doesNotMatch(document.querySelectorAll('table')[1].textContent ?? '', /Position|Streak|L1|NFC East/)
      assert.deepEqual([...document.querySelectorAll('h5')].map((heading) => heading.textContent), ['Dallas', 'Houston'])
      assert.match(document.body.textContent ?? '', /Known player.*Questionable/)
      assert.match(document.body.textContent ?? '', /No current injury records.*Houston.*does not confirm/)
      assert.doesNotMatch(document.body.textContent ?? '', /First observed|Last observed|Injury date/)
    } finally {
      dom.window.close()
    }
  })

  it('renders calculated records with source and cutoff context instead of provider rank and streak', () => {
    const snapshot = structuredClone(matchupSnapshot)
    snapshot.standings.items[0].recordBasis = {
      source: 'completed_regular_season_results', beforeKickoff: snapshot.targetMatchup!.kickoff.timestamp,
      latestGameTimestamp: 1790000000,
    }
    const markdown = render(snapshot)
    assert.match(markdown, /2026-09-21T14:13:20.000Z/)
    assert.match(markdown, /Regular-season records calculated from completed results before target kickoff/)
    const fact = buildAnalyticsFacts(snapshot).facts.find((item) => item.id === 'standing.29')!
    assert.match(fact.statement, /calculated from completed results before/)
    assert.doesNotMatch(fact.statement, /position 3|streak L1|observation time unknown/)
    assert.match(render(), /Stored season records; their observation time is unknown/)
  })

  for (const homeSpread of [-3, 2.5, 0]) {
    for (const side of ['away', 'home'] as const) {
      it(`locks the ${side} spread sign for home spread ${homeSpread}`, () => {
        const snapshot = withOdds(homeSpread, 47.5)
        const draft = createMatchupDraft(snapshot)
        draft.predictions.spread.selection = side
        const selectedLine = side === 'home' ? homeSpread : -homeSpread
        const line = selectedLine === 0 ? "0 (pick'em)" : `${selectedLine > 0 ? '+' : ''}${selectedLine}`
        assert(render(snapshot, draft).includes(`| ATS | ${snapshot.targetMatchup![`${side}Team`].name} to cover | ${markdownText(line)} |`))
        draft.predictions.total.selection = 'over'
        assert.match(render(snapshot, draft), /\| O\/U \| Over \| 47.5 \|/)
      })
    }
  }

  it('handles missing markets independently, empty history and absent records without invented values', () => {
    for (const [spread, total] of [[null, 48], [-3, null], [null, null]] as const) {
      const snapshot = withOdds(spread, total)
      const draft = createMatchupDraft(snapshot)
      assert.deepEqual(parseMatchupDraft(JSON.stringify(draft), 'stop', snapshot), draft)
      const markdown = render(snapshot, draft)
      if (spread == null) assert.match(markdown, /\| ATS \| Unavailable \| Unavailable \| No current consensus line/)
      else assert.match(markdown, /\| ATS \| Dallas to cover/)
      if (total == null) assert.match(markdown, /\| O\/U \| Unavailable \| Unavailable \| No current consensus line/)
      else assert.match(markdown, /\| O\/U \| Under/)
    }
    const empty = buildAnalyticsSnapshot('matchup_preview', matchupSnapshot.filters, {
      ...matchupSource, games: [], teamStats: [], standings: [], injuries: [], players: [],
    })
    const markdown = render(empty)
    assert.match(markdown, /\| ATS \| Unavailable \| \\-3 \| No supporting completed-game history/)
    assert.match(markdown, /\| O\/U \| Unavailable \| 48 \| No supporting completed-game history/)
    assert.match(markdown, /\| Dallas \| Unavailable \| Unavailable \|/)
    assert.doesNotMatch(markdown, /NaN|Infinity/)
  })

  it('keeps internal verification diagnostics without warning text or verifier prose in the report', (t) => {
    const warnings: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
    const draft = createMatchupDraft()
    draft.summary = { text: 'An uncited summary.', factIds: [] }
    const markdown = renderMatchupReport(matchupSnapshot, draft, new Map())
    assert(warnings.length > 0)
    assert.match(markdown, /An uncited summary/)
    assert.match(markdown, /local LLM may provide unsupported or incorrect facts/)
    assert.doesNotMatch(markdown, /Unverified statement|Unsupported statement|did not return a verdict/)
    assert.doesNotMatch(renderMatchupReport(matchupSnapshot, draft,
      new Map([['summary', { verdict: 'supported', reason: 'Invented unchecked explanation.' }]])), /Invented unchecked explanation/)
  })

  it('escapes source/narrative markup, hides internal references and does not mutate saved snapshots', () => {
    const snapshot = structuredClone(matchupSnapshot)
    snapshot.targetMatchup!.awayTeam.name = '**Dallas** | [fake](javascript:bad)\n## Invented <script>bad</script>'
    const draft = createMatchupDraft(snapshot)
    draft.summary.text = 'Team ID 29 and game ID 21570: <img src="https://example.com/pixel"> **Fake**'
    const before = JSON.stringify(snapshot)
    const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content: render(snapshot, draft) })))
    try {
      assert.equal(dom.window.document.querySelectorAll('script,img').length, 0)
      assert(![...dom.window.document.querySelectorAll('a')].some((link) => link.href.startsWith('javascript:')))
      assert.equal(dom.window.document.querySelectorAll('h3').length, 1)
      assert.doesNotMatch(dom.window.document.body.textContent ?? '', /Team ID 29|game ID 21570/)
      assert.equal(JSON.stringify(snapshot), before)
    } finally {
      dom.window.close()
    }
  })
})

describe('matchup schema and factual checks', () => {
  const facts = buildAnalyticsFacts(matchupSnapshot).facts
  it('requires exact bounded fields and one injury statement per team', () => {
    const draft = createMatchupDraft()
    assert.deepEqual(parseMatchupDraft(JSON.stringify(draft), 'stop', matchupSnapshot), draft)
    const schema = buildMatchupDraftSchema(facts, matchupSnapshot)
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, ['summary', 'notes', 'injuries', 'predictions'])
    assert.equal(schema.properties.notes.maxItems, 3)
    for (const value of [
      { ...draft, extra: true }, { ...draft, notes: [] }, { ...draft, notes: Array(4).fill(draft.notes[0]) },
      { ...draft, summary: { text: 'x'.repeat(351), factIds: [] } },
      { ...draft, summary: { text: 'word '.repeat(51), factIds: [] } },
      { ...draft, notes: [{ text: 'word '.repeat(26), factIds: [] }] },
      { ...draft, injuries: { ...draft.injuries, home: [draft.injuries.home] } },
      { ...draft, injuries: { ...draft.injuries, away: { text: 'word '.repeat(31), factIds: [] } } },
      { ...draft, summary: { text: 'Text.', factIds: ['limitation.prediction', 'limitation.prediction'] } },
    ]) assert.throws(() => parseMatchupDraft(JSON.stringify(value), 'stop', matchupSnapshot), AnalyticsReportError)
    assert.throws(() => parseMatchupDraft('bad JSON', 'stop', matchupSnapshot), /valid matchup narrative JSON/)
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'length', matchupSnapshot), /did not finish normally/)
    const injury = schema.properties.injuries.properties.away
    assert(!injury.properties.factIds.items.enum.includes('injury-summary.26'))
    assert(injury.properties.factIds.items.enum.includes('injury-summary.29'))
  })

  it('rejects invented picks, model-supplied lines and missing or unrelated supporting facts', () => {
    const draft = createMatchupDraft()
    for (const prediction of [
      { ...draft.predictions.spread, selection: 'over' },
      { ...draft.predictions.spread, line: -9 },
      { ...draft.predictions.spread, reason: { text: 'A guess.', factIds: [] } },
      { ...draft.predictions.spread, reason: { text: 'A guess.', factIds: ['matchup.spread'] } },
      { ...draft.predictions.spread, reason: { text: 'A guess.', factIds: ['matchup.spread', 'injury.0'] } },
      { ...draft.predictions.spread, reason: { text: 'A guess.', factIds: ['matchup.spread', 'team.999.all.ats'] } },
    ]) assert.throws(() => parseMatchupDraft(JSON.stringify({
      ...draft, predictions: { ...draft.predictions, spread: prediction },
    }), 'stop', matchupSnapshot), AnalyticsReportError)
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'stop', withOdds(null, 48)), /requires a consensus line/)
    const missing = buildMatchupDraftSchema(facts, withOdds(null, 48))
    assert.deepEqual(missing.properties.predictions.properties.spread.properties.selection.enum, ['unavailable'])
    assert.throws(() => parseMatchupDraft(JSON.stringify(draft), 'stop', withOdds(Infinity, 48)), /invalid consensus line/)
  })

  it('checks team-scoped injuries, identities, values and compatible arithmetic internally', () => {
    const check = (text: string, factIds: string[]) =>
      checkMatchupStatement({ id: 'summary', section: 'summary', text, factIds }, facts)
    assert.equal(check('An uncited statement.', [])?.verdict, 'unverified')
    assert.equal(check('Invented source.', ['fake'])?.verdict, 'unsupported')
    assert.equal(check('Team ID 999 is stronger.', ['team.29.all.ats'])?.verdict, 'unsupported')
    assert.equal(check('Average total yards are 9999.', ['stats.29.totalYards'])?.verdict, 'unsupported')
    assert.equal(check('Average total yards are 300.', ['stats.29.totalYards']), null)
    assert.equal(checkMatchupStatement({
      id: 'injuries.away', section: 'injuries', teamId: 29,
      text: 'Houston has no supplied records.', factIds: ['injury-summary.26'],
    }, facts)?.verdict, 'unsupported')
    assert.equal(checkMatchupStatement({
      id: 'notes.0', section: 'notes', text: 'An injury.', factIds: ['injury.0'],
    }, facts)?.verdict, 'unsupported')
    const compatible = [29, 26].map((id, index) => ({
      ...facts.find((fact) => fact.id === 'stats.29.totalYards')!,
      id: `comparison.${id}`, teamId: id, value: index ? 280 : 300,
      comparisonKey: 'same:totalYards', unit: 'yards', statement: `Average yards ${index ? 280 : 300}.`,
    }))
    assert.equal(checkMatchupStatement({
      id: 'notes.0', section: 'notes', text: 'The difference is 20.', factIds: compatible.map((fact) => fact.id),
    }, compatible), null)
    compatible[1].comparisonKey = 'different:scope'
    assert.equal(checkMatchupStatement({
      id: 'notes.0', section: 'notes', text: 'The difference is 20.', factIds: compatible.map((fact) => fact.id),
    }, compatible)?.verdict, 'unsupported')
  })
})

describe('mocked local-model matchup pipeline', () => {
  it('uses two batched calls, validates rationale rather than predicting certainty, and combines usage', async () => {
    const draft = createMatchupDraft()
    const calls: Parameters<LlamaClient['completeMessages']>[] = []
    const before = JSON.stringify(matchupSnapshot)
    const result = await generateMatchupReport({
      async completeMessages(...args: Parameters<LlamaClient['completeMessages']>) {
        calls.push(args)
        return completion(calls.length === 1 ? draft : supportedMatchupVerdicts(draft))
      },
    }, matchupSnapshot)
    assert.equal(calls.length, 2)
    assert.equal(calls[0][2]?.json_schema.name, 'matchup_narratives')
    assert.equal(calls[1][2]?.json_schema.name, 'matchup_verification')
    assert.match(calls[0][0][1].content, /50 words.*25 words/)
    assert.match(calls[0][0][1].content, /exactly one plain-text bullet/)
    assert.match(calls[1][0][0].content, /check factual assertions in their reasons/)
    assert.match(result.content, /Matchup Summary: Dallas at Houston/)
    assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
    assert.equal(JSON.stringify(matchupSnapshot), before)
  })

  it('gives generation and verification independent request deadlines using a mocked HTTP client', async (t) => {
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
        choices: [{ message: { content: JSON.stringify(index === 1 ? draft : supportedMatchupVerdicts(draft)) }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const client = new LlamaClient({ ...getLlamaConfig({ LLM_MODEL: 'test-model' }), timeoutMs: 100 })
    const pending = generateMatchupReport(client, matchupSnapshot)
    t.mock.timers.tick(60)
    await verificationStarted
    t.mock.timers.tick(60)
    assert.match((await pending).content, /Current Injuries/)
    assert.equal(calls, 2)
  })

  it('logs verifier failures without bringing back warnings or uncertainty sections', async (t) => {
    const logs: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args))
    for (const failure of ['unavailable', 'malformed', 'duplicate', 'unfinished', 'missing'] as const) {
      const draft = createMatchupDraft()
      let calls = 0
      const result = await generateMatchupReport({
        async completeMessages() {
          if (++calls === 1) return completion(draft)
          if (failure === 'unavailable') throw new LlamaClientError('unavailable', 'Local verifier unavailable.')
          if (failure === 'malformed') return completion({}, { content: 'not JSON' })
          const answers = supportedMatchupVerdicts(draft)
          if (failure === 'unfinished') return completion(answers, { finishReason: 'length' })
          if (failure === 'duplicate') answers.verdicts[1] = answers.verdicts[0]
          if (failure === 'missing') answers.verdicts.pop()
          return completion(answers)
        },
      }, matchupSnapshot)
      assert.match(result.content, /local LLM may provide unsupported or incorrect facts/)
      assert.doesNotMatch(result.content, /Narrative verification failed|Unverified statement|Summary of Uncertainty/)
    }
    assert(logs.some((args) => String(args[0]).includes('Narrative verification failed')))
  })

  it('rejects malformed/unfinished generation before verification and preserves cancellation and unexpected errors', async () => {
    const draft = createMatchupDraft()
    for (const answer of [completion({}, { content: 'bad' }), completion(draft, { finishReason: 'length' })]) {
      let calls = 0
      await assert.rejects(generateMatchupReport({
        async completeMessages() { calls++; return answer },
      }, matchupSnapshot), AnalyticsReportError)
      assert.equal(calls, 1)
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
    await assert.rejects(generateMatchupReport({
      async completeMessages() { throw new Error('Should not call model') },
    }, matchupSnapshot, AbortSignal.abort()), /abort/i)
  })
})
