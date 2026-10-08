import { buildAnalyticsSnapshot, type AnalyticsSourceData } from '../server/analytics-core'
import { MATCHUP_SECTIONS, type MatchupDraft } from '../server/matchup-report'

export const matchupSource: AnalyticsSourceData = {
  games: Array.from({ length: 4 }, (_, index) => ({
    game_id: index + 1, season: 2026, stage: 'Regular Season', week: `Week ${index + 1}`,
    game_date: `2026-09-0${index + 1}`, game_timestamp: 100 + index,
    away_team_id: index % 2 ? 26 : 29, away_team_name: index % 2 ? 'Houston' : 'Dallas',
    home_team_id: index % 2 ? 29 : 26, home_team_name: index % 2 ? 'Dallas' : 'Houston',
    away_score: 23, home_score: 25, final_total: 48, home_margin: 2,
    closing_home_spread: index === 3 ? null : index === 2 ? -2 : -3,
    spread_bookmaker_count: index === 3 ? 0 : 2,
    spread_delta: index === 3 ? null : index === 2 ? 0 : -1,
    spread_result: index === 3 ? 'ungraded' : index === 2 ? 'push' : 'away_cover',
    closing_total: index === 3 ? null : 47 + index,
    total_bookmaker_count: index === 3 ? 0 : 2,
    total_delta: index === 3 ? null : 1 - index,
    total_result: index === 3 ? 'ungraded' : index === 0 ? 'over' : index === 1 ? 'push' : 'under',
  })),
  teamStats: Array.from({ length: 4 }, (_, index) => ({
    game_id: index + 1, team_id: 29, yards_total: 300,
    pass_yards: index === 3 ? null : 200, rush_yards: 100,
    turnovers_total: index === 3 ? 0 : 1, sacks: 3,
    sacks_yards_lost: index === 3 ? 'unknown' : '1-8',
  })),
  standings: [{
    team_id: 29, conference: 'NFC', division: 'NFC East', position: 3,
    won: 1, lost: 2, ties: 0, points_for: 70, points_against: 80, streak: 'L1',
  }],
  injuries: [{
    player_id: 10, team_id: 29, injury_date: '2026-09-20', status: 'Questionable',
    description: 'Knee', first_seen_at: '2026-09-20T12:00:00Z', last_seen_at: '2026-10-02T12:00:00Z',
  }],
  players: [{ id: 10, name: 'Known player', position: 'CB' }],
  playerStats: [],
  targetMatchup: {
    gameId: 21570, season: 2026, stage: 'Regular Season', week: 'Week 4',
    status: { short: 'NS', long: 'Not Started' },
    kickoff: { date: '2026-10-04', timestamp: 1791122400 },
    awayTeam: { id: 29, name: 'Dallas' }, homeTeam: { id: 26, name: 'Houston' },
    venue: { name: 'Stored stadium', city: 'Houston' },
    currentConsensusOdds: { homeSpread: -3, total: 48 },
  },
  evidenceScope: { season: 2026, stage: 'Regular Season', excludedStage: null, beforeKickoff: 1791122400, teamIds: [26, 29] },
}

export const matchupSnapshot = buildAnalyticsSnapshot(
  'matchup_preview', { season: 2026, gameId: 21570 }, matchupSource, '2026-10-04T12:00:00Z',
)

export function createMatchupDraft(): MatchupDraft {
  const entry = () => ({ text: 'These observations are descriptive, not predictive probabilities.', factIds: ['limitation.prediction'] })
  const sections = {} as MatchupDraft['sections']
  for (const id of Object.keys(MATCHUP_SECTIONS) as Array<keyof typeof MATCHUP_SECTIONS>) {
    sections[id] = { interpretation: entry(), summary: entry() }
  }
  return { sections, overall: [entry()] }
}

export function supportedMatchupVerdicts(draft: MatchupDraft): {
  verdicts: Array<{ statementId: string; verdict: 'supported' | 'unsupported' | 'unverified'; reason: string }>
} {
  return {
    verdicts: [
      ...Object.keys(draft.sections).flatMap((id) => ['interpretation', 'summary'].map((kind) => ({
        statementId: `${id}.${kind}`, verdict: 'supported' as const, reason: 'The cited evidence supports this descriptive statement.',
      }))),
      ...draft.overall.map((_, index) => ({
        statementId: `overall.${index}`, verdict: 'supported' as const, reason: 'The cited evidence supports this descriptive statement.',
      })),
    ],
  }
}
