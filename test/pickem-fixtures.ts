import type { PickemAnalysis, PickemWeekView, PickemWeeksResponse } from '../src/api/pickem-contracts'

export const pickemWeek = { season: 2026, stage: 'Regular Season', week: 'Week 4' }
export const pickemAnalysis: PickemAnalysis = {
  ...pickemWeek,
  id: '99000000-0000-4000-8000-000000000044', revision: 1,
  createdAt: '2026-09-24T12:00:00.000Z', updatedAt: '2026-09-24T12:00:00.000Z',
  summary: 'Initial outright predictions saved.', changes: [],
  predictions: [{
    gameId: 21570, kickoffAt: '2026-10-04T17:00:00.000Z',
    awayTeamId: 29, awayTeamName: 'Dallas', homeTeamId: 26, homeTeamName: 'Houston',
    winnerTeamId: 29, confidence: 61,
    supportingPoints: [{ text: 'The supplied scoring sample offers limited support for Dallas.', evidenceIds: ['team.29.all'] }],
    risks: [{ text: 'Reported injuries create uncertainty, not confirmed absences.', evidenceIds: ['injuries.29.0'] }],
    model: 'test-model', analyzedAt: '2026-09-24T12:00:00.000Z', result: 'pending',
    sourceRefreshedAt: '2026-09-24T11:59:00.000Z', dataWarnings: ['Houston: no active injury records supplied; this does not establish a healthy team.'],
    finalAwayScore: null, finalHomeScore: null, gradedAt: null,
  }],
}
export const pickemView: PickemWeekView = {
  ...pickemWeek, analysis: pickemAnalysis,
  record: { wins: 0, losses: 0, ties: 0, pending: 1, void: 0 },
  games: [{
    gameId: 21570, kickoffAt: '2026-10-04T17:00:00.000Z', status: 'NS',
    awayTeamId: 29, awayTeamName: 'Dallas', homeTeamId: 26, homeTeamName: 'Houston',
    homeSpread: -7, awayScore: null, homeScore: null, eligible: true, locked: false,
  }],
}
export const pickemWeeks: PickemWeeksResponse = {
  weeks: [{ ...pickemWeek, firstKickoff: pickemView.games[0].kickoffAt, analysisId: pickemAnalysis.id, revision: 1 }],
  defaultWeek: pickemWeek, record: pickemView.record,
}
