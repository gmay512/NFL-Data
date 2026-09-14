import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentConsensusOdds } from '../src/data/current-consensus'

function clientWithRows(
  handler: (gameIds: number[]) => { data: unknown; error: unknown },
) {
  const calls: number[][] = []
  const client = {
    rpc: async (name: string, args: { requested_game_ids: number[] }) => {
      assert.equal(name, 'get_game_consensus_odds')
      calls.push(args.requested_game_ids)
      return handler(args.requested_game_ids)
    },
  } as unknown as SupabaseClient
  return { calls, client }
}

describe('current consensus odds loader', () => {
  it('deduplicates, chunks, normalizes, and orders requested games', async () => {
    const { calls, client } = clientWithRows((gameIds) => ({
      data: gameIds.map((gameId) => ({
        game_id: String(gameId),
        home_spread: gameId === 2 ? null : '-3.5',
        total: '44.5',
      })).reverse(),
      error: null,
    }))

    const rows = await getCurrentConsensusOdds(client, [3, 1, 2, 3, -1], 2)

    assert.deepEqual(calls, [[3, 1], [2]])
    assert.deepEqual(rows, [
      { game_id: 1, home_spread: -3.5, total: 44.5 },
      { game_id: 2, home_spread: null, total: 44.5 },
      { game_id: 3, home_spread: -3.5, total: 44.5 },
    ])
  })

  it('returns early without an RPC and propagates query errors', async () => {
    const empty = clientWithRows(() => {
      throw new Error('RPC should not run')
    })
    assert.deepEqual(await getCurrentConsensusOdds(empty.client, []), [])
    assert.deepEqual(empty.calls, [])

    const queryError = { code: '57014', message: 'statement timeout' }
    const failing = clientWithRows(() => ({ data: null, error: queryError }))
    await assert.rejects(
      getCurrentConsensusOdds(failing.client, [1]),
      (error) => error === queryError,
    )
  })

  it('rejects invalid RPC rows and chunk sizes', async () => {
    const invalid = clientWithRows(() => ({
      data: [{ game_id: 1, home_spread: 'not-a-number', total: 44 }],
      error: null,
    }))
    await assert.rejects(getCurrentConsensusOdds(invalid.client, [1]), /non-numeric/)
    await assert.rejects(getCurrentConsensusOdds(invalid.client, [1], 0), /positive integer/)
  })
})
