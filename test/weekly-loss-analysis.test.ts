import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WeeklyAnalysisService,
  type WeeklyAnalysisSnapshot,
  type WeeklyAnalysisStore,
  type WeeklySuggestion,
} from '../server/weekly-analysis'
import {
  buildWeeklyLossEvidence,
  buildWeeklyLossMessages,
  parseWeeklyLossAnalysis,
  WeeklyLossAnalysisError,
  type GameTeamStatRow,
  type WeeklyLossAnalysis,
} from '../server/weekly-loss-analysis'

function losingSuggestion(overrides: Partial<WeeklySuggestion> = {}): WeeklySuggestion {
  return {
    id: 8,
    runId: '99000000-0000-4000-8000-000000000008',
    gameId: 42,
    season: 2026,
    stage: 'Regular Season',
    week: 'Week 4',
    kickoffAt: '2026-09-27T17:00:00.000Z',
    awayTeamId: 2,
    awayTeamName: 'Visitors',
    homeTeamId: 1,
    homeTeamName: 'Hosts',
    market: 'spread',
    selection: 'away',
    lockedLine: 3.5,
    confidence: 61,
    rationale: 'Prior ATS evidence.',
    supportingGameIds: [31],
    result: 'loss',
    resultDelta: -2.5,
    finalAwayScore: 20,
    finalHomeScore: 26,
    gradedAt: '2026-09-28T00:00:00.000Z',
    createdAt: '2026-09-22T20:00:00.000Z',
    lossAnalysis: null,
    ...overrides,
  }
}

const matchup = {
  gameId: 42,
  target: {
    awayTeam: { id: 2, name: 'Visitors' },
    homeTeam: { id: 1, name: 'Hosts' },
  },
  teamPerformance: [
    { teamId: 2, teamName: 'Visitors', averagePointsFor: 24, averagePointsAgainst: 20 },
    { teamId: 1, teamName: 'Hosts', averagePointsFor: 21, averagePointsAgainst: 22 },
  ],
  teamStatTrends: [
    {
      teamId: 2,
      teamName: 'Visitors',
      averageTotalYards: 360,
      averagePassYards: 240,
      averageRushYards: 120,
      averageTurnovers: 1,
      averageSacks: 2,
    },
    {
      teamId: 1,
      teamName: 'Hosts',
      averageTotalYards: 330,
      averagePassYards: 220,
      averageRushYards: 110,
      averageTurnovers: 1.5,
      averageSacks: 2.5,
    },
  ],
} as unknown as WeeklyAnalysisSnapshot['matchups'][number]

const stats: GameTeamStatRow[] = [
  {
    team_id: 2,
    fd_total: 17,
    third_down_eff: '3/12',
    fourth_down_eff: '0/1',
    plays_total: 58,
    yards_total: 287,
    yards_per_play: '4.9',
    total_drives: '10',
    pass_yards: 221,
    rush_yards: 66,
    red_zone: '1/3',
    penalties: '8-70',
    turnovers_total: 3,
    possession: '27:14',
    sacks: 1,
  },
  {
    team_id: 1,
    fd_total: 22,
    third_down_eff: '7/13',
    fourth_down_eff: '1/1',
    plays_total: 65,
    yards_total: 381,
    yards_per_play: '5.9',
    total_drives: '11',
    pass_yards: 249,
    rush_yards: 132,
    red_zone: '3/4',
    penalties: '4-35',
    turnovers_total: 1,
    possession: '32:46',
    sacks: 3,
  },
]

function modelOutput(metricKey = 'actual.away.turnovers') {
  return JSON.stringify({
    summary: 'Turnovers and weaker offensive efficiency were the strongest clues in the failed cover.',
    clues: [{
      category: 'turnovers',
      title: 'Turnover disadvantage',
      explanation: 'The selected team committed more turnovers in the completed game.',
      metricKeys: [metricKey, 'actual.home.turnovers'],
    }],
  })
}

describe('weekly loss evidence and model validation', () => {
  it('builds auditable actual and pregame metrics without converting missing values to zero', () => {
    const evidence = buildWeeklyLossEvidence(losingSuggestion(), matchup, stats)
    assert.equal(evidence.metrics['actual.away.turnovers'].value, 3)
    assert.equal(evidence.metrics['baseline.away.averageTotalYards'].value, 360)
    assert.equal(evidence.metrics['outcome.resultDelta'].value, -2.5)
    assert.deepEqual(evidence.missingMetrics, [])
    assert.match(buildWeeklyLossMessages(evidence)[0].content, /Use only the supplied evidence JSON/)
  })

  it('records unavailable metrics and accepts a single insufficient-evidence clue', () => {
    const evidence = buildWeeklyLossEvidence(losingSuggestion(), matchup, [])
    assert.ok(evidence.missingMetrics.includes('Visitors turnovers'))
    assert.ok(!Object.hasOwn(evidence.metrics, 'actual.away.turnovers'))
    const parsed = parseWeeklyLossAnalysis(JSON.stringify({
      summary: 'The final score is known, but the box score is too incomplete for a supported explanation.',
      clues: [{
        category: 'insufficient_evidence',
        title: 'Insufficient box-score evidence',
        explanation: 'Team statistics were unavailable.',
        metricKeys: [],
      }],
    }), evidence)
    assert.equal(parsed.clues[0].category, 'insufficient_evidence')
  })

  it('rejects unsupported metric references and malformed prose', () => {
    const evidence = buildWeeklyLossEvidence(losingSuggestion(), matchup, stats)
    assert.throws(
      () => parseWeeklyLossAnalysis(modelOutput('actual.away.imaginary'), evidence),
      (error) => error instanceof WeeklyLossAnalysisError && error.code === 'invalid_model_output',
    )
    assert.throws(
      () => parseWeeklyLossAnalysis('The turnovers mattered.', evidence),
      (error) => error instanceof WeeklyLossAnalysisError && error.code === 'invalid_model_output',
    )
  })
})

function storedAnalysis(evidence: ReturnType<typeof buildWeeklyLossEvidence>): WeeklyLossAnalysis {
  const parsed = parseWeeklyLossAnalysis(modelOutput(), evidence)
  return {
    id: 12,
    suggestionId: 8,
    analysisVersion: 1,
    model: 'test-model',
    evidence,
    summary: parsed.summary,
    clues: parsed.clues,
    missingMetrics: evidence.missingMetrics,
    createdAt: '2026-09-29T20:00:00.000Z',
  }
}

function lossStore(
  input: NonNullable<Awaited<ReturnType<WeeklyAnalysisStore['getLossAnalysisInput']>>>,
  calls: string[],
): WeeklyAnalysisStore {
  return {
    async save() { throw new Error('not used') },
    async list() { return [] },
    async delete() { return false },
    async listPendingGameIds() { return [] },
    async gradePending() { return 0 },
    async getLossAnalysisInput(id) {
      calls.push(`load:${id}`)
      return input
    },
    async saveLossAnalysis(value) {
      calls.push(`save:${value.suggestionId}`)
      return storedAnalysis(value.evidence)
    },
    async deleteLossAnalysis() { return false },
  }
}

describe('weekly one-game loss analysis orchestration', () => {
  it('refreshes one game, calls the model, validates output, and saves once', async () => {
    const calls: string[] = []
    const input = { suggestion: losingSuggestion(), matchup, teamStats: stats }
    const llama = {
      async completeMessages() {
        calls.push('model')
        return {
          content: modelOutput(),
          model: 'test-model',
          finishReason: 'stop',
          usage: null,
          latencyMs: 1,
        }
      },
    }
    const service = new WeeklyAnalysisService(
      {} as SupabaseClient,
      {} as never,
      llama as never,
      lossStore(input, calls),
      async () => 0,
      () => '2026-09-29T20:00:00.000Z',
      () => {},
      async (gameId) => {
        calls.push(`refresh:${gameId}`)
        return stats
      },
    )

    const analysis = await service.analyzeLoss(8)
    assert.equal(analysis.suggestionId, 8)
    assert.deepEqual(calls, ['load:8', 'refresh:42', 'load:8', 'model', 'save:8'])
  })

  it('rejects an existing analysis before refreshing or calling the model', async () => {
    const calls: string[] = []
    const evidence = buildWeeklyLossEvidence(losingSuggestion(), matchup, stats)
    const input = {
      suggestion: losingSuggestion({ lossAnalysis: storedAnalysis(evidence) }),
      matchup,
      teamStats: stats,
    }
    const service = new WeeklyAnalysisService(
      {} as SupabaseClient,
      {} as never,
      {} as never,
      lossStore(input, calls),
      async () => 0,
      undefined,
      undefined,
      async () => {
        calls.push('refresh')
        return []
      },
    )
    await assert.rejects(
      service.analyzeLoss(8),
      (error) => error instanceof WeeklyLossAnalysisError && error.code === 'analysis_exists',
    )
    assert.deepEqual(calls, ['load:8'])
  })
})
