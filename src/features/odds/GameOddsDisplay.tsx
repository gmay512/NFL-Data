import { formatConsensusSpread, formatConsensusTotal } from '../../lib/odds-format'
import type { GameOddsRow } from '../../types/nfl'

export function GameOddsDisplay({
  odds,
  awayTeamName,
  homeTeamName,
  variant = 'schedule',
}: {
  odds?: GameOddsRow | null
  awayTeamName?: string
  homeTeamName?: string
  variant?: 'schedule' | 'detail'
}) {
  const spread = formatConsensusSpread(odds, awayTeamName, homeTeamName)
  const total = formatConsensusTotal(odds)
  if (!spread && !total) return null

  return (
    <div className={`game-odds game-odds-${variant}`} aria-label="Consensus game odds">
      {spread && (
        <span className="game-odds-item">
          <small>Spread</small>
          <strong>{spread}</strong>
        </span>
      )}
      {total && (
        <span className="game-odds-item">
          <small>Total</small>
          <strong>{total}</strong>
        </span>
      )}
    </div>
  )
}
