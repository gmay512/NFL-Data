export type PickemWeek = { season: number; stage: string | null; week: string }
export type PickemPoint = { text: string; evidenceIds: string[] }
export type PickemResult = 'pending' | 'win' | 'loss' | 'tie' | 'void'
export type PickemRecord = { wins: number; losses: number; ties: number; pending: number; void: number }
export type PickemComparison = {
  winnerTeamId: number
  winnerTeamName: string
  confidence: number
  supportingPoints: PickemPoint[]
  risks: PickemPoint[]
  evidence: Record<string, unknown>
}
export type PickemChange = {
  gameId: number
  kind: 'added' | 'updated' | 'removed'
  before: PickemComparison | null
  after: PickemComparison | null
}
export type PickemPrediction = {
  gameId: number
  kickoffAt: string
  awayTeamId: number
  awayTeamName: string
  homeTeamId: number
  homeTeamName: string
  winnerTeamId: number
  confidence: number
  supportingPoints: PickemPoint[]
  risks: PickemPoint[]
  model: string
  analyzedAt: string
  sourceRefreshedAt: string
  dataWarnings: string[]
  result: PickemResult
  finalAwayScore: number | null
  finalHomeScore: number | null
  gradedAt: string | null
}
export type PickemAnalysis = PickemWeek & {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  summary: string
  changes: PickemChange[]
  predictions: PickemPrediction[]
}
export type PickemGame = {
  gameId: number
  kickoffAt: string | null
  status: string | null
  awayTeamId: number | null
  awayTeamName: string
  homeTeamId: number | null
  homeTeamName: string
  homeSpread: number | null
  awayScore: number | null
  homeScore: number | null
  eligible: boolean
  locked: boolean
}
export type PickemWeekView = PickemWeek & {
  games: PickemGame[]
  analysis: PickemAnalysis | null
  record: PickemRecord
}
export type PickemWeeksResponse = {
  weeks: Array<PickemWeek & { firstKickoff: string | null; analysisId: string | null; revision: number }>
  defaultWeek: PickemWeek | null
  record: PickemRecord
}
export type PickemGradeResponse = {
  graded: number
  requestedGames: number
  refreshedGames: number
  refreshError: string | null
}
export type PickemStreamEvent =
  | { type: 'progress'; message: string }
  | { type: 'complete'; analysis: PickemAnalysis }
  | { type: 'error'; error: string; code: string }
