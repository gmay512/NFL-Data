import type { GameRow } from '../types/nfl'

const terminalGameStatuses = new Set(['FT', 'AOT', 'CANC', 'PST'])

export function shouldRefreshGame(game: GameRow, now = Date.now()) {
  const status = game.status_short?.trim().toUpperCase()
  if (status && terminalGameStatuses.has(status)) return false
  if (status && status !== 'NS') return true
  if (game.game_timestamp == null) return false
  return game.game_timestamp * 1000 <= now
}
