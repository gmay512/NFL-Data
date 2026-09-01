begin;

select plan(22);

select ok(
  has_table_privilege('service_role', 'public.game_closing_consensus_odds', 'select'),
  'allows the analytics service to read closing odds'
);
select ok(
  has_table_privilege('service_role', 'public.game_betting_results', 'select'),
  'allows the analytics service to read betting results'
);

insert into public.teams (id, name)
values
  (990001, 'Closing Odds Away'),
  (990002, 'Closing Odds Home');

insert into public.games (
  id,
  season,
  stage,
  week,
  home_team_id,
  away_team_id,
  game_date,
  game_timestamp,
  status_short,
  home_total,
  away_total
)
values
  (990001, 2099, 'Regular Season', 'Week 1', 990002, 990001, '2099-09-01', extract(epoch from '2099-09-01 18:00:00+00'::timestamptz)::bigint, 'FT', 27, 20),
  (990002, 2099, 'Regular Season', 'Week 2', 990002, 990001, '2099-09-08', extract(epoch from '2099-09-08 18:00:00+00'::timestamptz)::bigint, 'AOT', 24, 21),
  (990003, 2099, 'Regular Season', 'Week 3', 990002, 990001, '2099-09-15', extract(epoch from '2099-09-15 18:00:00+00'::timestamptz)::bigint, 'FT', 17, 14);

insert into public.bookmakers (id, name)
values
  (990001, 'Closing Odds Book One'),
  (990002, 'Closing Odds Book Two');

insert into public.bet_types (id, name)
values
  (990001, 'Asian Handicap'),
  (990002, 'Over/Under');

insert into public.odds (
  game_id,
  bookmaker_id,
  bet_id,
  bet_value,
  odd,
  provider_updated_at,
  captured_at
)
values
  -- Opening snapshot for game 1; a later pre-kickoff snapshot must replace it.
  (990001, 990001, 990001, 'Home -2.5', 1.91, '2099-09-01 16:00:00+00', '2099-09-01 16:01:00+00'),
  (990001, 990001, 990001, 'Away +2.5', 1.91, '2099-09-01 16:00:00+00', '2099-09-01 16:01:00+00'),
  (990001, 990001, 990002, 'Over 43.5', 1.91, '2099-09-01 16:00:00+00', '2099-09-01 16:01:00+00'),
  (990001, 990001, 990002, 'Under 43.5', 1.91, '2099-09-01 16:00:00+00', '2099-09-01 16:01:00+00'),
  -- Closing snapshots from two bookmakers produce median lines of -4 and 45.
  (990001, 990001, 990001, 'Home -3.5', 1.91, '2099-09-01 17:50:00+00', '2099-09-01 17:51:00+00'),
  (990001, 990001, 990001, 'Away +3.5', 1.91, '2099-09-01 17:50:00+00', '2099-09-01 17:51:00+00'),
  (990001, 990001, 990002, 'Over 44.5', 1.91, '2099-09-01 17:50:00+00', '2099-09-01 17:51:00+00'),
  (990001, 990001, 990002, 'Under 44.5', 1.91, '2099-09-01 17:50:00+00', '2099-09-01 17:51:00+00'),
  (990001, 990002, 990001, 'Home -4.5', 1.91, '2099-09-01 17:55:00+00', '2099-09-01 17:56:00+00'),
  (990001, 990002, 990001, 'Away +4.5', 1.91, '2099-09-01 17:55:00+00', '2099-09-01 17:56:00+00'),
  (990001, 990002, 990002, 'Over 45.5', 1.91, '2099-09-01 17:55:00+00', '2099-09-01 17:56:00+00'),
  (990001, 990002, 990002, 'Under 45.5', 1.91, '2099-09-01 17:55:00+00', '2099-09-01 17:56:00+00'),
  -- These more recent rows are after kickoff and must not affect closing lines.
  (990001, 990001, 990001, 'Home -7', 1.91, '2099-09-01 18:05:00+00', '2099-09-01 18:06:00+00'),
  (990001, 990001, 990001, 'Away +7', 1.91, '2099-09-01 18:05:00+00', '2099-09-01 18:06:00+00'),
  (990001, 990001, 990002, 'Over 50', 1.91, '2099-09-01 18:05:00+00', '2099-09-01 18:06:00+00'),
  (990001, 990001, 990002, 'Under 50', 1.91, '2099-09-01 18:05:00+00', '2099-09-01 18:06:00+00'),
  -- Game 2 lands exactly on both whole-number lines.
  (990002, 990001, 990001, 'Home -3', 1.91, '2099-09-08 17:50:00+00', '2099-09-08 17:51:00+00'),
  (990002, 990001, 990001, 'Away +3', 1.91, '2099-09-08 17:50:00+00', '2099-09-08 17:51:00+00'),
  (990002, 990001, 990002, 'Over 45', 1.91, '2099-09-08 17:50:00+00', '2099-09-08 17:51:00+00'),
  (990002, 990001, 990002, 'Under 45', 1.91, '2099-09-08 17:50:00+00', '2099-09-08 17:51:00+00'),
  -- Newer partial snapshots must not displace the latest complete market.
  (990002, 990001, 990001, 'Home -6', 1.91, '2099-09-08 17:55:00+00', '2099-09-08 17:56:00+00'),
  (990002, 990001, 990002, 'Over 50', 1.91, '2099-09-08 17:55:00+00', '2099-09-08 17:56:00+00');

select is(
  (select home_spread from public.game_closing_consensus_odds where game_id = 990001),
  (-4)::numeric,
  'uses the median closing spread across bookmakers'
);
select is(
  (select total from public.game_closing_consensus_odds where game_id = 990001),
  45::numeric,
  'uses the median closing total across bookmakers'
);
select is(
  (select spread_bookmaker_count from public.game_closing_consensus_odds where game_id = 990001),
  2,
  'reports the spread bookmaker count'
);
select is(
  (select total_bookmaker_count from public.game_closing_consensus_odds where game_id = 990001),
  2,
  'reports the total bookmaker count'
);
select is(
  (select spread_source_first_updated_at from public.game_closing_consensus_odds where game_id = 990001),
  '2099-09-01 17:50:00+00'::timestamptz,
  'reports the earliest selected spread source timestamp'
);
select is(
  (select spread_source_last_updated_at from public.game_closing_consensus_odds where game_id = 990001),
  '2099-09-01 17:55:00+00'::timestamptz,
  'reports the latest selected spread source timestamp'
);
select is(
  (select total_source_first_updated_at from public.game_closing_consensus_odds where game_id = 990001),
  '2099-09-01 17:50:00+00'::timestamptz,
  'reports the earliest selected total source timestamp'
);
select is(
  (select total_source_last_updated_at from public.game_closing_consensus_odds where game_id = 990001),
  '2099-09-01 17:55:00+00'::timestamptz,
  'reports the latest selected total source timestamp'
);
select isnt(
  (select home_spread from public.game_closing_consensus_odds where game_id = 990001),
  (-7)::numeric,
  'excludes post-kickoff spread snapshots'
);
select isnt(
  (select total from public.game_closing_consensus_odds where game_id = 990001),
  50::numeric,
  'excludes post-kickoff total snapshots'
);
select is(
  (select spread_result from public.game_betting_results where game_id = 990001),
  'home_cover',
  'grades a home spread cover'
);
select is(
  (select spread_delta from public.game_betting_results where game_id = 990001),
  3::numeric,
  'reports the spread result delta'
);
select is(
  (select total_result from public.game_betting_results where game_id = 990001),
  'over',
  'grades an over result'
);
select is(
  (select total_delta from public.game_betting_results where game_id = 990001),
  2::numeric,
  'reports the total result delta'
);
select is(
  (select spread_result from public.game_betting_results where game_id = 990002),
  'push',
  'grades a whole-number spread push'
);
select is(
  (select total_result from public.game_betting_results where game_id = 990002),
  'push',
  'grades a whole-number total push'
);
select is(
  (select spread_source_last_updated_at from public.game_closing_consensus_odds where game_id = 990002),
  '2099-09-08 17:50:00+00'::timestamptz,
  'uses the latest complete spread snapshot'
);
select is(
  (select total_source_last_updated_at from public.game_closing_consensus_odds where game_id = 990002),
  '2099-09-08 17:50:00+00'::timestamptz,
  'uses the latest complete total snapshot'
);
select is(
  (select spread_result from public.game_betting_results where game_id = 990003),
  'ungraded',
  'keeps a completed game without spread odds ungraded'
);
select is(
  (select total_result from public.game_betting_results where game_id = 990003),
  'ungraded',
  'keeps a completed game without total odds ungraded'
);

select * from finish();
rollback;
