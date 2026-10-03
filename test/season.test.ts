import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getCurrentNflSeason, selectCurrentSeason, shouldImportSeasonMetadata } from '../src/lib/season'

describe('current-season defaults', () => {
  it('keeps the initial season and advances after the NFL offseason rollover', () => {
    assert.equal(getCurrentNflSeason(new Date('2026-01-01T00:00:00Z')), 2026)
    assert.equal(getCurrentNflSeason(new Date('2026-10-03T00:00:00Z')), 2026)
    assert.equal(getCurrentNflSeason(new Date('2027-02-28T23:59:59Z')), 2026)
    assert.equal(getCurrentNflSeason(new Date('2027-03-01T00:00:00Z')), 2027)
  })

  it('uses current metadata but does not default to reloaded historical seasons', () => {
    const now = new Date('2026-10-03T00:00:00Z')
    assert.equal(selectCurrentSeason([{ season: 2027, current: true }], now), 2027)
    assert.equal(selectCurrentSeason([{ season: 2025, current: true }], now), 2026)
    assert.equal(selectCurrentSeason([{ season: 2030, current: false }], now), 2026)
    assert.equal(selectCurrentSeason([{ season: 2026, current: true }], new Date('2027-09-01T00:00:00Z')), 2027)
  })

  it('imports old metadata only when the year/range was explicitly requested', () => {
    assert.equal(shouldImportSeasonMetadata(2025, [2026]), false)
    assert.equal(shouldImportSeasonMetadata(2026, [2026]), true)
    assert.equal(shouldImportSeasonMetadata(2027, [2026]), true)
    assert.equal(shouldImportSeasonMetadata(2023, [2023]), true)
    assert.equal(shouldImportSeasonMetadata(2024, [2023]), false)
    assert.equal(shouldImportSeasonMetadata(2024, [2023, 2024, 2025]), true)
  })
})
