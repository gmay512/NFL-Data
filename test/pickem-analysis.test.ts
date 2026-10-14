import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { buildAnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import {
  buildPickemEvidence, isPickemStage, parsePickemCompletion, parsePickemWeek,
  PickemError, pickemGameEligibility, pickemRecord, pickemResponseSchema,
  PickemService, requireCompleteRefresh, type PickemStore,
} from '../server/pickem-analysis'
import type { LlamaCompletion } from '../server/llama-client'
import { matchupSnapshot, matchupSource } from './matchup-report-fixtures'
import { pickemAnalysis, pickemView, pickemWeek, pickemWeeks } from './pickem-fixtures'

const evidence = buildPickemEvidence(matchupSnapshot, [
  ...matchupSource.teamStats,
  { game_id: 1, team_id: 26, yards_total: 400, pass_yards: null, rush_yards: null, turnovers_total: null, sacks: null },
], '2026-09-24T12:00:00Z')
function completion(overrides: Record<string, unknown> = {}): LlamaCompletion {
  return {
    content: JSON.stringify({
      gameId: 21570, winnerTeamId: 29, confidence: 61,
      supportingPoints: [{ text: 'Dallas scoring offers limited support.', evidenceIds: ['team.29.all'] }],
      risks: [{ text: 'Reported injuries are not confirmed game-day availability.', evidenceIds: ['injuries.29.0'] }],
      ...overrides,
    }),
    model: 'test-model', finishReason: 'stop', usage: null, latencyMs: 1,
  }
}

describe('Pickem deterministic grounding and validation', () => {
  it('includes outright records, both teams, injury positions and correct opponent defense attribution', () => {
    assert.match(evidence.facts['team.29.all'], /2 outright wins, 2 losses/)
    assert.match(evidence.facts['injuries.29.0'], /Known player, CB; reported Questionable/)
    assert.match(evidence.facts['injuries.26.coverage'], /does not confirm a healthy team/)
    assert.match(evidence.facts['stats.29.yardsAllowed'], /400.*1 observed games of 4/)
    assert.match(evidence.facts['stats.26.yardsAllowed'], /300.*4 observed games of 4/)
    assert.match(evidence.facts['stats.29.sacksAllowed'], /offensive sacks allowed/)
    assert.match(evidence.facts.spread, /not an ATS selection/)
    assert.match(evidence.facts.matchup, /Neutral-site status is unknown/)
    assert.match(evidence.facts.matchup, /do not label this as a neutral-site game/)
    assert(pickemResponseSchema(evidence))
  })
  for (const [homeSpread, expected] of [
    [-3, /spread favorite is Houston; Dallas is the spread underdog/],
    [3, /spread favorite is Dallas; Houston is the spread underdog/],
    [0, /neither team is favored/],
    [null, /spread favorite is unavailable/],
  ] as const) {
    it(`supplies the correct spread favorite for home spread ${homeSpread}`, () => {
      const snapshot = { ...matchupSnapshot, targetMatchup: {
        ...matchupSnapshot.targetMatchup!,
        currentConsensusOdds: { ...matchupSnapshot.targetMatchup!.currentConsensusOdds, homeSpread },
      } }
      assert.match(buildPickemEvidence(snapshot, [], '2026-09-24T12:00:00Z').facts.spread, expected)
    })
  }
  it('does not turn missing statistics into zeros and discloses limited/truncated evidence', () => {
    const limited = { ...matchupSnapshot, currentInjuries: { ...matchupSnapshot.currentInjuries, truncated: true } }
    const facts = buildPickemEvidence(limited, [], '2026-09-24T12:00:00Z').facts
    assert.match(facts['stats.26.sacksAllowed'], /unavailable/)
    assert.match(facts['stats.29.yardsAllowed'], /unavailable/)
    assert.match(facts.truncation, /Bounded evidence/)
  })
  it('distinguishes the preceding scheduled kickoff interval from time since the last observed result', () => {
    const grounded = buildPickemEvidence(matchupSnapshot, [], '2026-09-24T12:00:00Z', [
      { teamId: 29, timestamp: matchupSnapshot.targetMatchup!.kickoff.timestamp - 7 * 86400 },
    ])
    assert.match(grounded.facts['team.29.scheduleInterval'], /7 days between/)
    assert.match(grounded.facts['team.29.lastObserved'], /NOT a rest interval/)
    assert(grounded.warnings.length > 0)
    assert(!Object.hasOwn(grounded.material, 'refreshedAt'))
  })
  it('accepts a participating outright winner without requiring a spread or prior games', () => {
    const source: AnalyticsSourceData = { ...matchupSource, games: [], teamStats: [], injuries: [], targetMatchup: {
      ...matchupSource.targetMatchup!, currentConsensusOdds: { homeSpread: null, total: null },
    } }
    const empty = buildPickemEvidence(buildAnalyticsSnapshot('matchup_preview', { season: 2026, gameId: 21570 }, source), [], '2026-09-24T12:00:00Z')
    const draft = parsePickemCompletion(completion({
      risks: [{ text: 'History and odds are unavailable.', evidenceIds: ['spread', 'team.29.all'] }],
    }), empty, '2026-09-24T12:00:00Z')
    assert.equal(draft.winnerTeamId, 29)
    assert.equal(draft.confidence, 61)
  })
  for (const overrides of [
    { gameId: 88 }, { winnerTeamId: 88 }, { winnerTeamId: '29' }, { confidence: 0 }, { confidence: 101 },
    { confidence: 50.5 }, { confidence: '60' }, { line: -7 }, { supportingPoints: [] }, { risks: [] },
    { supportingPoints: [{ text: 'Foreign evidence.', evidenceIds: ['game.unknown'] }] },
    { risks: [{ text: 'Multiline\ntext.', evidenceIds: ['limitations'] }] },
    { risks: [{ text: 'Dallas scoring offers limited support.', evidenceIds: ['team.29.all'] }] },
  ]) {
    it(`rejects invalid output ${JSON.stringify(overrides)}`, () => {
      assert.throws(() => parsePickemCompletion(completion(overrides), evidence, '2026-09-24T12:00:00Z'),
        (error) => error instanceof PickemError && error.code === 'invalid_model_output')
    })
  }
  it('rejects malformed and unfinished completions', () => {
    assert.throws(() => parsePickemCompletion({ ...completion(), content: 'not JSON' }, evidence, '2026-09-24T12:00:00Z'))
    assert.throws(() => parsePickemCompletion({ ...completion(), finishReason: 'length' }, evidence, '2026-09-24T12:00:00Z'))
  })
  it('validates stage and week input and excludes preseason', () => {
    assert.equal(isPickemStage('Pre Season'), false)
    assert.equal(isPickemStage('Post Season'), true)
    assert.deepEqual(parsePickemWeek(pickemWeek), pickemWeek)
    assert.throws(() => parsePickemWeek({ ...pickemWeek, season: '2026' }))
    assert.throws(() => parsePickemWeek({ ...pickemWeek, stage: 'Pre Season' }))
    assert.throws(() => parsePickemWeek({ ...pickemWeek, week: '' }))
  })
  it('locks kickoff-passed, in-progress and graded predictions, including stale scheduled status', () => {
    const game = pickemView.games[0]
    assert.equal(pickemGameEligibility(game, '2026-09-24T12:00:00Z').eligible, true)
    assert.equal(pickemGameEligibility(game, '2026-10-04T17:00:00Z').locked, true)
    assert.equal(pickemGameEligibility({ ...game, status: 'Q1' }, '2026-09-24T12:00:00Z').locked, true)
    assert.equal(pickemGameEligibility(game, '2026-09-24T12:00:00Z', {
      ...pickemAnalysis.predictions[0], kickoffAt: '2026-09-23T12:00:00Z',
    }).locked, true)
    assert.equal(pickemGameEligibility(game, '2026-09-24T12:00:00Z', {
      ...pickemAnalysis.predictions[0], result: 'win',
    }).eligible, false)
  })
  it('separates ties and voids from win/loss records', () => {
    const record = pickemRecord((['win', 'loss', 'tie', 'pending', 'void'] as const).map((result) => ({
      ...pickemAnalysis.predictions[0], result,
    })))
    assert.deepEqual(record, { wins: 1, losses: 1, ties: 1, pending: 1, void: 1 })
  })
  it('treats partially failed and zero-attempt refreshes as failures', () => {
    assert.throws(() => requireCompleteRefresh('Injury', { attempted: 32, failedIds: [29] }), /29/)
    assert.throws(() => requireCompleteRefresh('Player stats', { attempted: 0, failedIds: [] }), /no teams/)
    assert.doesNotThrow(() => requireCompleteRefresh('Injury', { attempted: 32, failedIds: [] }))
  })
})

function serviceFixture(options: {
  refresh?: () => Promise<void>
  model?: (gameId: number) => Promise<LlamaCompletion>
  view?: typeof pickemView
  results?: () => Promise<number>
} = {}) {
  const view = options.view ?? {
    ...pickemView, analysis: null,
    games: [21570, 21571].map((gameId) => ({ ...pickemView.games[0], gameId })),
  }
  const calls = { saved: 0, refreshed: 0, models: [] as number[], graded: 0 }
  const store: PickemStore = {
    async weeks() { return pickemWeeks },
    async week() { return view },
    async save(_week, _revision, drafts) {
      calls.saved++
      assert.equal(drafts.length, view.games.filter((game) => game.eligible).length)
      return pickemAnalysis
    },
    async pendingGameIds() { return [21570] },
    async grade() { calls.graded++; return 1 },
  }
  const client = createClient('http://localhost:9999', 'test-key', {
    global: { fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) },
  })
  const service = new PickemService(client, {
    async load(filters) { return { ...matchupSource, targetMatchup: { ...matchupSource.targetMatchup!, gameId: filters.gameId! } } },
  }, {
    async completeMessages(messages) {
      const payload = JSON.parse(messages[1].content) as { gameId: number; facts: Record<string, string> }
      calls.models.push(payload.gameId)
      assert(Object.hasOwn(payload.facts, 'injuries.29.0'))
      assert.match(messages[0].content, /explicitly supplied spread favorite/)
      assert.match(messages[0].content, /Verify numeric comparisons/)
      assert.match(messages[0].content, /Unknown neutral-site status is not confirmed/)
      return options.model ? options.model(payload.gameId) : completion({ gameId: payload.gameId })
    },
  }, store, async () => {
    calls.refreshed++
    await options.refresh?.()
  }, async () => options.results ? options.results() : 1, () => '2026-09-24T12:00:00Z')
  return { service, calls }
}

describe('Pickem complete-slate generation and result refresh', () => {
  it('refreshes and analyzes every eligible game before a single save', async () => {
    const { service, calls } = serviceFixture()
    const messages: string[] = []
    await service.analyze(pickemWeek, 0, (message) => messages.push(message))
    assert.deepEqual(calls.models, [21570, 21571])
    assert.equal(calls.saved, 1)
    assert.equal(calls.refreshed, 1)
    assert.match(messages.at(-1)!, /Saving the complete/)
  })
  it('never sends locked games to the model', async () => {
    const { service, calls } = serviceFixture({ view: {
      ...pickemView, games: [
        { ...pickemView.games[0], eligible: false, locked: true, status: 'FT' },
        { ...pickemView.games[0], gameId: 21571 },
      ],
    } })
    await service.analyze(pickemWeek, 1, () => {})
    assert.deepEqual(calls.models, [21571])
  })
  it('preserves the saved analysis after any required refresh failure', async () => {
    const { service, calls } = serviceFixture({ refresh: async () => { throw new Error('Provider unavailable') } })
    await assert.rejects(service.analyze(pickemWeek, 0, () => {}), /Provider unavailable/)
    assert.equal(calls.saved, 0)
    assert.deepEqual(calls.models, [])
  })
  it('does not save a partial slate if a later matchup fails', async () => {
    const { service, calls } = serviceFixture({ model: async (gameId) => completion({ gameId, ...(gameId === 21571 ? { winnerTeamId: 99 } : {}) }) })
    await assert.rejects(service.analyze(pickemWeek, 0, () => {}), /invalid game, winner/)
    assert.equal(calls.saved, 0)
  })
  it('cancels before saving without substituting a favorite', async () => {
    const controller = new AbortController()
    const { service, calls } = serviceFixture({ model: async (gameId) => { controller.abort(); return completion({ gameId }) } })
    await assert.rejects(service.analyze(pickemWeek, 0, () => {}, controller.signal))
    assert.equal(calls.saved, 0)
  })
  it('rejects stale revisions before refresh or model calls', async () => {
    const { service, calls } = serviceFixture({ view: pickemView })
    await assert.rejects(service.analyze(pickemWeek, 0, () => {}), /changed/)
    assert.equal(calls.refreshed, 0)
  })
  it('grades stored finals despite provider failure and explicitly reports it', async () => {
    const { service, calls } = serviceFixture({ results: async () => { throw new Error('API unavailable') } })
    const result = await service.grade(pickemWeek)
    assert.equal(calls.graded, 2)
    assert.equal(result.graded, 2)
    assert.match(result.refreshError!, /API unavailable/)
  })
  it('deduplicates concurrent automatic/manual grading for the same week', async () => {
    const { service, calls } = serviceFixture()
    const first = service.grade(pickemWeek)
    const second = service.grade(pickemWeek)
    assert.equal(first, second)
    await first
    assert.equal(calls.graded, 2)
  })
})
