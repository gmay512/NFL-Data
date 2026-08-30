import type { GameOddsRow } from '../types/nfl'

function formatLine(value: number) {
  return Number(value.toFixed(2)).toString()
}

export function formatConsensusSpread(
  odds: GameOddsRow | null | undefined,
  awayTeamName = 'Away',
  homeTeamName = 'Home',
) {
  if (odds?.home_spread == null) return null
  if (odds.home_spread === 0) return "Pick'em"

  const favoredTeam = odds.home_spread < 0 ? homeTeamName : awayTeamName
  return `${favoredTeam} -${formatLine(Math.abs(odds.home_spread))}`
}

export function formatConsensusTotal(odds: GameOddsRow | null | undefined) {
  return odds?.total == null ? null : `O/U ${formatLine(odds.total)}`
}
