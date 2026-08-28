import type { GameRow } from '../types/nfl'

type GameStatus = Pick<GameRow, 'status_long' | 'status_short' | 'status_timer'>
type GameSchedule = Pick<GameRow, 'game_date' | 'game_time'>
type ScoredGame = Pick<GameRow, 'away_total' | 'home_total' | 'status_short'>

export function formatScheduleGameStatus(game: GameStatus) {
  if (game.status_short === 'FT') return 'Final'
  if (game.status_short === 'NS') return 'Scheduled'
  if (game.status_short === 'HT') return 'Half time'
  if (game.status_short && game.status_timer) return `${game.status_short} ${game.status_timer}`
  return game.status_long || game.status_short || 'Scheduled'
}

export function formatDetailGameStatus(game: GameStatus | null) {
  if (!game) return 'Loading'
  if (game.status_short === 'FT') return 'Final'
  if (game.status_short === 'NS') return 'Scheduled'
  if (game.status_short === 'PST') return 'Postponed'
  if (game.status_short === 'CANC') return 'Cancelled'
  if (game.status_short && game.status_timer) return `${game.status_short} ${game.status_timer}`
  return game.status_long || game.status_short || 'Unknown status'
}

export function formatScheduleGameDate(game: GameSchedule) {
  if (!game.game_date) return 'Date pending'

  const [year, month, day] = game.game_date.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const formattedDate = Number.isNaN(date.getTime())
    ? game.game_date
    : new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date)

  if (!game.game_time) return formattedDate

  const [hours, minutes] = game.game_time.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return formattedDate

  const meridiem = hours >= 12 ? 'PM' : 'AM'
  const formattedTime = `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${meridiem}`
  const timeZoneAbbreviation = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
    .formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'ET'

  return `${formattedDate} · ${formattedTime} ${timeZoneAbbreviation}`
}

export function formatValue(value: string | number | null | undefined) {
  return value == null || value === '' ? '—' : String(value)
}

export function formatScore(value: number | null | undefined) {
  return value == null ? '—' : value
}

export function isWinningTeam(game: ScoredGame, team: 'away' | 'home') {
  if (!['FT', 'AOT'].includes(game.status_short ?? '')) return false
  if (game.away_total == null || game.home_total == null || game.away_total === game.home_total) return false
  return team === 'away' ? game.away_total > game.home_total : game.home_total > game.away_total
}
