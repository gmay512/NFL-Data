import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mapBetTypeRows,
  mapGameEventRows,
  mapInjuryRows,
  mapLeagueSeasonRow,
  mapOddsRows,
  mapPlayerSeasonStatRows,
  mapStandingRows,
  isGameEligibleForOdds,
} from '../server/ingest-core'

describe('game event ingestion', () => {
  it('maps the current API minute and score fields', () => {
    const result = mapGameEventRows(22705, [{
      quarter: 'Fourth',
      minute: '0:55',
      team: { id: 314 },
      player: { id: 42, name: 'M. Beason', image: 'player.png' },
      type: 'TD',
      comment: 'M. Beason run for 1 yd, for a TD',
      score: { home: 47, away: 37 },
    }])

    assert.deepEqual(result.players, [{
      id: 42,
      name: 'M. Beason',
      image_url: 'player.png',
    }])
    assert.deepEqual(result.rows, [{
      game_id: 22705,
      team_id: 314,
      player_id: 42,
      quarter: 'Fourth',
      minute: '0:55',
      event_type: 'TD',
      comment: 'M. Beason run for 1 yd, for a TD',
      score_home: 47,
      score_away: 37,
    }])
  })

  it('supports legacy time and nested scores aliases', () => {
    const result = mapGameEventRows(1, [{
      quarter: 'Second',
      time: '1:13',
      team: { id: 10 },
      type: 'FG',
      scores: { home: { total: 10 }, away: { total: 7 } },
    }])

    assert.deepEqual(result.rows[0], {
      game_id: 1,
      team_id: 10,
      player_id: null,
      quarter: 'Second',
      minute: '1:13',
      event_type: 'FG',
      comment: null,
      score_home: 10,
      score_away: 7,
    })
  })

  it('ignores rows missing required team, quarter, or event type fields', () => {
    const result = mapGameEventRows(1, [
      { quarter: 'First', type: 'TD' },
      { team: { id: 10 }, type: 'TD' },
      { team: { id: 10 }, quarter: 'First' },
    ])

    assert.deepEqual(result, { players: [], rows: [] })
  })
})

describe('odds ingestion', () => {
    it('selects upcoming games through 14 days and missing recent games through 7 days', () => {
      const now = new Date('2026-08-30T17:00:00Z')
      const game = (
        id: number,
        gameDate: string,
        status: string,
        kickoff = Date.parse(`${gameDate}T17:00:00Z`) / 1_000,
      ) => ({
        id,
        game_date: gameDate,
        game_timestamp: kickoff,
        status_short: status,
      })

      assert.equal(isGameEligibleForOdds(game(1, '2026-09-13', 'NS'), true, now), true)
      assert.equal(isGameEligibleForOdds(game(2, '2026-09-14', 'NS'), false, now), false)
      assert.equal(isGameEligibleForOdds(game(3, '2026-08-23', 'FT'), false, now), true)
      assert.equal(isGameEligibleForOdds(game(4, '2026-08-23', 'FT'), true, now), false)
      assert.equal(isGameEligibleForOdds(game(5, '2026-08-22', 'FT'), false, now), false)
    })

    it('uses scheduled status when a game has no kickoff timestamp', () => {
      const now = new Date('2026-08-30T17:00:00Z')
      const baseGame = {
        id: 1,
        game_date: '2026-09-01',
        game_timestamp: null,
      }

      assert.equal(isGameEligibleForOdds({ ...baseGame, status_short: 'NS' }, true, now), true)
      assert.equal(isGameEligibleForOdds({ ...baseGame, status_short: 'FT' }, true, now), false)
      assert.equal(isGameEligibleForOdds({ ...baseGame, status_short: 'FT' }, false, now), true)
    })

    it('keeps provider market IDs when display names are duplicated', () => {
      assert.deepEqual(mapBetTypeRows([
        { id: 75, name: 'Player Passing Yards' },
        { id: 211, name: 'Player Passing Yards' },
      ]), [
        { id: 75, name: 'Player Passing Yards' },
        { id: 211, name: 'Player Passing Yards' },
      ])
    })

    describe('supplemental data ingestion', () => {
      it('maps current injury fields and player references', () => {
        const result = mapInjuryRows([{
          player: { id: 2098, name: 'Tyler Biadasz', image: 'player.png' },
          team: { id: 30 },
          date: '2026-08-23',
          status: 'I.L.',
          description: 'I.L. - Knee',
        }], '2026-08-30T20:00:00Z')

        assert.deepEqual(result.players, [{
          id: 2098,
          name: 'Tyler Biadasz',
          image_url: 'player.png',
        }])
        assert.deepEqual(result.rows, [{
          player_id: 2098,
          team_id: 30,
          injury_date: '2026-08-23',
          status: 'I.L.',
          description: 'I.L. - Knee',
          last_seen_at: '2026-08-30T20:00:00.000Z',
          resolved_at: null,
        }])
      })

      it('maps and deduplicates team-scoped player season statistics', () => {
        const result = mapPlayerSeasonStatRows([{
          player: { id: 50, name: 'Denzel Perryman', image: 'player.png' },
          teams: [{
            team: { id: 30, name: 'Los Angeles Chargers', logo: 'team.png' },
            groups: [{
              name: 'Defense',
              statistics: [
                { name: 'unassisted tackles', value: '54' },
                { name: 'unassisted tackles', value: '54' },
                { name: 'assisted tackles', value: 32 },
              ],
            }],
          }],
        }], 2026)

        assert.deepEqual(result.players, [{ id: 50, name: 'Denzel Perryman', image_url: 'player.png' }])
        assert.deepEqual(result.teams, [{ id: 30, name: 'Los Angeles Chargers', logo_url: 'team.png' }])
        assert.deepEqual(result.rows, [
          {
            player_id: 50,
            team_id: 30,
            season: 2026,
            stat_group: 'Defense',
            stat_name: 'unassisted tackles',
            stat_value: '54',
          },
          {
            player_id: 50,
            team_id: 30,
            season: 2026,
            stat_group: 'Defense',
            stat_name: 'assisted tackles',
            stat_value: '32',
          },
        ])
      })

      it('maps scalar standings and nested records', () => {
        assert.deepEqual(mapStandingRows([{
          league: { id: 1, season: 2025 },
          team: { id: 3 },
          conference: 'American Football Conference',
          division: 'AFC East',
          position: 1,
          won: 14,
          lost: 3,
          ties: 0,
          points: { for: 490, against: 320, difference: 170 },
          records: { home: '6-3', road: '8-0', conference: '9-3', division: '5-1' },
          streak: 'W3',
        }], 2025), [{
          league_id: 1,
          season: 2025,
          team_id: 3,
          conference: 'American Football Conference',
          division: 'AFC East',
          position: 1,
          won: 14,
          lost: 3,
          ties: 0,
          points_for: 490,
          points_against: 320,
          points_diff: 170,
          record_home: '6-3',
          record_road: '8-0',
          record_conference: '9-3',
          record_division: '5-1',
          streak: 'W3',
        }])
      })

      it('qualifies legacy cardinal divisions with their conference', () => {
        const rows = mapStandingRows([{
          league: { id: 1, season: 2022 },
          team: { id: 3 },
          conference: 'American Football Conference',
          division: 'East',
        }], 2022)

        assert.equal(rows[0]?.division, 'AFC East')
      })

      it('maps the provider coverage paths', () => {
        assert.deepEqual(mapLeagueSeasonRow(1, {
          year: 2026,
          start: '2026-08-07',
          end: '2027-02-14',
          current: true,
          coverage: {
            games: { events: true, statisitcs: { teams: true, players: true } },
            statistics: { season: { players: true } },
            players: true,
            injuries: true,
            standings: false,
          },
        }), {
          league_id: 1,
          season_year: 2026,
          start_date: '2026-08-07',
          end_date: '2027-02-14',
          is_current: true,
          cov_games_events: true,
          cov_stats_teams: true,
          cov_stats_players: true,
          cov_season_players: true,
          cov_players: true,
          cov_injuries: true,
          cov_standings: false,
        })
      })
    })

    it('maps all valid bookmaker, market, and outcome combinations', () => {
      const rows = mapOddsRows([{
        game: { id: 17530 },
        update: '2025-12-13T12:00:15+00:00',
        bookmakers: [{
          id: 4,
          bets: [
            {
              id: 1,
              values: [
                { value: 'Home', odd: '1.20' },
                { value: 'Away', odd: '4.75' },
              ],
            },
            {
              id: 2,
              values: [
                { value: 'Home -3.5', odd: '1.91' },
                { value: 'Away +3.5', odd: '1.95' },
              ],
            },
            {
              id: 3,
              values: [{ value: 'Over 47.5', odd: '1.88' }],
            },
            {
              id: 75,
              values: [{ value: 'Player A Over 249.5', odd: '2.05' }],
            },
          ],
        }],
      }])

      assert.equal(rows.length, 6)
      assert.deepEqual(rows[0], {
        game_id: 17530,
        bookmaker_id: 4,
        bet_id: 1,
        bet_value: 'Home',
        odd: 1.2,
        provider_updated_at: '2025-12-13T12:00:15.000Z',
      })
      assert.deepEqual(rows.at(-1), {
        game_id: 17530,
        bookmaker_id: 4,
        bet_id: 75,
        bet_value: 'Player A Over 249.5',
        odd: 2.05,
        provider_updated_at: '2025-12-13T12:00:15.000Z',
      })
    })

    it('deduplicates retries, retains later snapshots, and skips malformed values', () => {
      const base = {
        game: { id: 10 },
        bookmakers: [{
          id: 2,
          bets: [{
            id: 3,
            values: [
              { value: 'Over 44.5', odd: '1.90' },
              { value: 'Over 44.5', odd: '1.90' },
              { value: 'Bad', odd: 'not-a-number' },
              { value: '', odd: '2.00' },
            ],
          }],
        }],
      }
      const rows = mapOddsRows([
        { ...base, update: '2026-09-01T12:00:00Z' },
        { ...base, update: '2026-09-01T13:00:00Z' },
        { ...base, game: { id: null }, update: '2026-09-01T14:00:00Z' },
      ])

      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map((row) => row.provider_updated_at), [
        '2026-09-01T12:00:00.000Z',
        '2026-09-01T13:00:00.000Z',
      ])
    })

    it('rejects snapshots without a provider update timestamp', () => {
      assert.throws(() => mapOddsRows([{
        game: { id: 10 },
        bookmakers: [{ id: 2, bets: [{ id: 1, values: [{ value: 'Home', odd: '1.5' }] }] }],
      }]), /missing a valid update timestamp/)
    })
})
