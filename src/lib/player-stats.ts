import type { GamePlayerStatRow } from '../types/nfl'

export type PlayerStatCategory = 'offense' | 'defense' | 'specialTeams'
export type PlayerUnit = PlayerStatCategory

export type GroupedStats = {
  group: string
  entries: Array<{ statName: string; statValue: string | null }>
}

export type PlayerStatsBucket = Record<PlayerUnit, GroupedStats[]>
export type SortDirection = 'ascending' | 'descending'

export type PlayerStatSortColumn =
  | { type: 'player' }
  | { type: 'stat'; statName: string }

export type PlayerStatTableRow = {
  playerId: number
  playerName: string
  stats: Map<string, string | null>
}

const offenseKeywords = ['passing', 'rushing', 'receiving', 'offense', 'offence']
const defenseKeywords = ['defense', 'defence', 'tackle', 'interception', 'sack', 'coverage', 'fumble']
const specialTeamsKeywords = ['special', 'kicking', 'kick', 'punt', 'return', 'field goal']

export function getPlayerStatCategory(statGroup: string): PlayerStatCategory {
  const normalized = statGroup.trim().toLowerCase()
  if (['rushing', 'receiving', 'passing', 'fumbles'].some((name) => normalized.includes(name))) return 'offense'
  if (['kicking', 'kick', 'punt', 'return'].some((name) => normalized.includes(name))) return 'specialTeams'
  return 'defense'
}

export function getPlayerStatGroupOrder(statGroup: string, category: PlayerStatCategory) {
  const normalized = statGroup.trim().toLowerCase()
  if (category === 'specialTeams') {
    if (normalized.includes('kick') && !normalized.includes('return')) return 0
    if (normalized.includes('kick return')) return 1
    if (normalized.includes('punt') && !normalized.includes('return')) return 2
    if (normalized.includes('punt return')) return 3
    return 4
  }

  const order = category === 'offense' ? ['passing', 'rushing', 'receiving', 'fumbles'] : []
  const index = order.findIndex((name) => normalized.includes(name))
  return index === -1 ? order.length : index
}

export function classifyPlayerStatGroup(group: string): PlayerUnit {
  const normalized = group.trim().toLowerCase()
  if (offenseKeywords.some((keyword) => normalized.includes(keyword))) return 'offense'
  if (defenseKeywords.some((keyword) => normalized.includes(keyword))) return 'defense'
  if (specialTeamsKeywords.some((keyword) => normalized.includes(keyword))) return 'specialTeams'
  return 'specialTeams'
}

export function getPlayerUnit(positionGroup: string | null | undefined): PlayerUnit | null {
  const normalized = positionGroup?.trim().toLowerCase()
  if (normalized === 'offense' || normalized === 'offence') return 'offense'
  if (normalized === 'defense' || normalized === 'defence') return 'defense'
  if (normalized === 'special teams' || normalized === 'special team') return 'specialTeams'
  return null
}

export function groupPlayerStats(rows: GamePlayerStatRow[]): PlayerStatsBucket {
  const groupedByBucket: Record<PlayerUnit, Map<string, GroupedStats>> = {
    offense: new Map(),
    defense: new Map(),
    specialTeams: new Map(),
  }

  for (const row of rows) {
    const group = row.stat_group || 'Unknown'
    const bucket = classifyPlayerStatGroup(group)
    const current = groupedByBucket[bucket].get(group)
    const entry = { statName: row.stat_name, statValue: row.stat_value }
    if (current) {
      current.entries.push(entry)
    } else {
      groupedByBucket[bucket].set(group, { group, entries: [entry] })
    }
  }

  const toSortedArray = (groups: Map<string, GroupedStats>) =>
    Array.from(groups.values()).sort((left, right) => left.group.localeCompare(right.group))

  return {
    offense: toSortedArray(groupedByBucket.offense),
    defense: toSortedArray(groupedByBucket.defense),
    specialTeams: toSortedArray(groupedByBucket.specialTeams),
  }
}

function isMissingStatValue(value: string | null | undefined) {
  return value == null || value.trim() === ''
}

function parseNumericStatValue(value: string) {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

export function compareStatValues(
  left: string | null | undefined,
  right: string | null | undefined,
  direction: SortDirection,
) {
  const leftMissing = isMissingStatValue(left)
  const rightMissing = isMissingStatValue(right)
  if (leftMissing || rightMissing) {
    if (leftMissing === rightMissing) return 0
    return leftMissing ? 1 : -1
  }

  const leftValue = left as string
  const rightValue = right as string
  const leftNumber = parseNumericStatValue(leftValue)
  const rightNumber = parseNumericStatValue(rightValue)
  const comparison =
    leftNumber != null && rightNumber != null
      ? leftNumber - rightNumber
      : leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' })

  return direction === 'ascending' ? comparison : -comparison
}

export function sortPlayerStatRows<T extends PlayerStatTableRow>(
  rows: T[],
  column: PlayerStatSortColumn,
  direction: SortDirection,
) {
  return [...rows].sort((left, right) => {
    const comparison =
      column.type === 'player'
        ? left.playerName.localeCompare(right.playerName, undefined, { sensitivity: 'base' })
        : compareStatValues(left.stats.get(column.statName), right.stats.get(column.statName), direction)
    const directedComparison =
      column.type === 'player' && direction === 'descending' ? -comparison : comparison

    return (
      directedComparison ||
      left.playerName.localeCompare(right.playerName, undefined, { sensitivity: 'base' }) ||
      left.playerId - right.playerId
    )
  })
}
