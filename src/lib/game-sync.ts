import type { GameRow } from '../types/nfl'

const terminalGameStatuses = new Set(['FT', 'AOT', 'CANC', 'PST'])

type RefreshableGame = Pick<GameRow, 'game_timestamp' | 'status_short'>
type LiveGameState = Pick<
  GameRow,
  'away_total' | 'home_total' | 'status_long' | 'status_short' | 'status_timer'
>

function haveEqualValues<T extends object>(left: T, right: T) {
  const leftKeys = Object.keys(left) as Array<keyof T>
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.is(left[key], right[key]))
}

export function reconcileRowsByKey<T extends object, K extends keyof T>(
  previous: T[],
  incoming: T[],
  key: K,
) {
  const previousByKey = new Map(previous.map((row) => [row[key], row]))
  const reconciled = incoming.map((row) => {
    const previousRow = previousByKey.get(row[key])
    return previousRow && haveEqualValues(previousRow, row) ? previousRow : row
  })

  return (
    reconciled.length === previous.length &&
    reconciled.every((row, index) => row === previous[index])
  )
    ? previous
    : reconciled
}

export function selectFirstRowsByKey<T extends object, K extends keyof T>(rows: T[], key: K) {
  const seen = new Set<T[K]>()
  return rows.filter((row) => {
    const value = row[key]
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

export function shouldRefreshGame(game: RefreshableGame, now = Date.now()) {
  const status = game.status_short?.trim().toUpperCase()
  if (status && terminalGameStatuses.has(status)) return false
  if (status && status !== 'NS') return true
  if (game.game_timestamp == null) return false
  return game.game_timestamp * 1000 <= now
}

export function getRefreshableGameIds<T extends RefreshableGame & { id: number }>(games: T[], now = Date.now()) {
  return games.filter((game) => shouldRefreshGame(game, now)).map((game) => game.id)
}

export function hasLiveGameChanged(previous: LiveGameState | undefined, current: LiveGameState) {
  if (!previous) return false
  return (
    previous.away_total !== current.away_total ||
    previous.home_total !== current.home_total ||
    previous.status_short !== current.status_short ||
    previous.status_long !== current.status_long ||
    previous.status_timer !== current.status_timer
  )
}
