import type { SupabaseClient } from '@supabase/supabase-js'
import type { GameOddsRow } from '../types/nfl'

const consensusGameIdChunkSize = 10

function normalizeNullableNumber(value: unknown) {
  if (value == null) return null
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('Consensus odds returned a non-numeric value.')
  return number
}

function normalizeConsensusRows(data: unknown): GameOddsRow[] {
  if (!Array.isArray(data)) throw new Error('Consensus odds returned an invalid response.')

  return data.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('Consensus odds returned an invalid row.')
    }
    const row = value as Record<string, unknown>
    const gameId = Number(row.game_id)
    if (!Number.isInteger(gameId) || gameId <= 0) {
      throw new Error('Consensus odds returned an invalid game id.')
    }
    return {
      game_id: gameId,
      home_spread: normalizeNullableNumber(row.home_spread),
      total: normalizeNullableNumber(row.total),
    }
  })
}

export async function getCurrentConsensusOdds(
  client: SupabaseClient,
  gameIds: number[],
  chunkSize = consensusGameIdChunkSize,
) {
  const requestedGameIds = [...new Set(gameIds.filter((gameId) => Number.isInteger(gameId) && gameId > 0))]
  if (!requestedGameIds.length) return []
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Consensus odds chunk size must be a positive integer.')
  }

  const rows: GameOddsRow[] = []
  for (let index = 0; index < requestedGameIds.length; index += chunkSize) {
    const { data, error } = await client.rpc('get_game_consensus_odds', {
      requested_game_ids: requestedGameIds.slice(index, index + chunkSize),
    })
    if (error) throw error
    rows.push(...normalizeConsensusRows(data))
  }
  return rows.sort((left, right) => left.game_id - right.game_id)
}
