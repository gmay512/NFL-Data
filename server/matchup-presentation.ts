import type { AnalyticsSnapshot } from './analytics-core'
import type { AnalyticsFact } from './analytics-facts'

const metricLabels: Record<string, string> = {
  totalYards: 'total yards', passYards: 'passing yards', rushYards: 'rushing yards',
  turnovers: 'turnovers committed (not turnover differential)',
  sacks: 'provider sacks (not sacks allowed)',
  sacksAllowed: 'sacks allowed from offensive sacks/yardage',
  pointsFor: 'points scored', pointsAgainst: 'points conceded',
  spreadDelta: 'team-perspective spread delta', ats: 'ATS record', totals: 'totals record',
}

const sectionLabels: Record<string, string> = {
  priorPerformance: 'Prior performance', injuries: 'Current injuries',
  homeSpread: 'Home spread performance', totals: 'Totals performance',
  efficiency: 'Offensive efficiency and turnovers', missingData: 'Missing or ungraded data',
  oddsContext: 'Odds context', overall: 'Overall observations',
}

export function matchupStatementLabel(id: string) {
  const [section, kind, index] = id.split('.')
  if (section === 'injuries' && (kind === 'away' || kind === 'home')) {
    return `Current injuries / ${kind === 'away' ? 'Away' : 'Home'} team / Observation ${Number(index) + 1}`
  }
  return `${sectionLabels[section] ?? 'Narrative'} / ${kind === 'interpretation' ? 'Interpretation' : kind === 'summary' ? 'Summary' : 'Observation'}`
}

export function createMatchupPresentation(snapshot: AnalyticsSnapshot, facts: AnalyticsFact[]) {
  const teams = new Map<number, string>()
  const players = new Map<number, string>()
  const games = new Map<number, string>()
  const byId = new Map(facts.map((fact) => [fact.id, fact]))
  function addName(names: Map<number, string>, id: number, name: string | null, kind: 'team' | 'player') {
    if (name?.trim() && !new RegExp(`^${kind}\\s*\\d+$`, 'i').test(name.trim()) && !names.has(id)) {
      names.set(id, name)
    }
  }
  const target = snapshot.targetMatchup
  if (target) {
    addName(teams, target.awayTeam.id, target.awayTeam.name, 'team')
    addName(teams, target.homeTeam.id, target.homeTeam.name, 'team')
  }
  for (const team of [...snapshot.teamTrends.items, ...snapshot.teamStatTrends.items]) {
    addName(teams, team.teamId, team.teamName, 'team')
  }
  for (const standing of snapshot.standings.items) addName(teams, standing.team_id, standing.teamName, 'team')
  for (const injury of snapshot.currentInjuries.items) {
    addName(players, injury.player_id, injury.playerName, 'player')
    if (injury.team_id != null) addName(teams, injury.team_id, injury.teamName, 'team')
  }
  for (const player of snapshot.playerStats.items) addName(players, player.player_id, player.playerName, 'player')
  for (const game of snapshot.games.items) {
    addName(teams, game.awayTeamId, game.awayTeamName, 'team')
    addName(teams, game.homeTeamId, game.homeTeamName, 'team')
  }
  const teamName = (id: number) => teams.get(id) ?? 'Unknown team'
  const playerName = (id: number) => players.get(id) ?? 'Unknown player'
  for (const game of snapshot.games.items) {
    games.set(game.gameId, `${teamName(game.awayTeamId)} at ${teamName(game.homeTeamId)}${game.gameDate ? ` on ${game.gameDate}` : ''}`)
  }
  if (target) games.set(target.gameId, `${teamName(target.awayTeam.id)} at ${teamName(target.homeTeam.id)} on ${target.kickoff.date}`)

  function reference(id: string) {
    const fact = byId.get(id)
    if (!fact) return 'unrecognized source reference'
    if (fact.metric === 'injury-summary' && fact.teamId != null) return `${teamName(fact.teamId)} supplied injury summary`
    if (fact.teamId != null && metricLabels[fact.metric]) return `${teamName(fact.teamId)} ${metricLabels[fact.metric]}`
    if (fact.playerId != null) return `${playerName(fact.playerId)} ${fact.section === 'injuries' ? 'injury record' : 'statistics'}`
    if (fact.gameIds.length === 1) return games.get(fact.gameIds[0]) ?? 'stored matchup'
    return `${fact.section === 'limitations' ? 'data limitation' : 'selected historical sample'}`
  }

  function text(value: string): string {
    return value
      .replace(/(?:^|\s)(?:\*\*)?(?:Sources|Model check|Evidence IDs)\s*:(?:\*\*)?[^\n]*/gim, '')
      .replace(/\b(?:matchup|sample|team|stats|standing|injury-summary|injury|player-stat|game|limitation)\.[\w-]+(?:\.[\w-]+)*/g, reference)
      .replace(/\b(?:priorPerformance|injuries|homeSpread|totals|efficiency|missingData|oddsContext|overall)\.(?:interpretation|summary|\d+|(?:away|home)\.\d+)\b/g, matchupStatementLabel)
      .replace(/\b(team|game|player)(?:[\s_-]*ids?)?["']?\s*(?:[:=#]\s*)?[[("']*(\d+(?:\s*,\s*\d+(?!\d|[.-]\d))*)\b(?![.-]\d)[\])"']*/gi,
        (_, kind: string, ids: string) => ids.split(',').map((id) => {
          const number = Number(id.trim())
          return kind.toLowerCase() === 'team' ? teamName(number)
            : kind.toLowerCase() === 'player' ? playerName(number) : games.get(number) ?? 'Unknown matchup'
        }).join(', '))
      .replace(/\b(?:[A-Za-z][\w]*?(?:Ids?|IDs?|_ids?)|[A-Za-z][\w-]*[\s-]+ids?|[Ii][Dd]s?|[Ii]dentifier)["']?\s*[:=#]?\s*[[("']*\d+(?:\s*,\s*\d+)*[\])"']*/g,
        'internal reference')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'internal reference')
      .replace(/displayed evidence IDs/g, 'displayed game detail')
      .replace(/^Evidence:/, 'History scope:')
      .trim()
  }

  function factText(fact: AnalyticsFact) {
    if (fact.section === 'statistics') {
      return text(`${fact.teamId == null ? 'Unknown team' : teamName(fact.teamId)}: average ${metricLabels[fact.metric] ?? 'statistic'} ${fact.value == null ? 'unavailable' : fact.value} per observed game.`)
    }
    if (fact.id === 'matchup.identity' && target) {
      return text(`${teamName(target.awayTeam.id)} (away) at ${teamName(target.homeTeam.id)} (home); ${target.season}, ${target.stage ?? 'stage unknown'}, ${target.week ?? 'week unknown'}.`)
    }
    return text(fact.statement)
  }

  function reason(value: string) {
    // Numeric-check failures can refer to a leaked identifier, not a statistic.
    return text(value.replace(/^Value \S+ is not supplied/, 'A numeric claim is not supplied'))
      || 'The statement could not be established from the supplied data.'
  }

  return { text, reason, teamName, factText }
}
