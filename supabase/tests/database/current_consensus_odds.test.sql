begin;

select plan(8);

select ok(
  to_regprocedure('public.get_game_consensus_odds(integer[])') is not null,
  'creates the bounded current consensus function'
);
select ok(
  has_function_privilege('anon', 'public.get_game_consensus_odds(integer[])', 'execute'),
  'allows anonymous clients to request current consensus'
);
select ok(
  has_function_privilege('authenticated', 'public.get_game_consensus_odds(integer[])', 'execute'),
  'allows authenticated clients to request current consensus'
);
select ok(
  has_function_privilege('service_role', 'public.get_game_consensus_odds(integer[])', 'execute'),
  'allows the ingestion service to request current consensus'
);

insert into public.teams (id, name)
values
  (991001, 'Bounded Odds Away'),
  (991002, 'Bounded Odds Home');

insert into public.games (
  id,
  season,
  stage,
  week,
  home_team_id,
  away_team_id,
  game_date,
  game_timestamp,
  status_short
)
values
  (991001, 2099, 'Regular Season', 'Week 1', 991002, 991001, '2099-09-01', extract(epoch from '2099-09-01 18:00:00+00'::timestamptz)::bigint, 'NS'),
  (991002, 2099, 'Regular Season', 'Week 2', 991002, 991001, '2099-09-08', extract(epoch from '2099-09-08 18:00:00+00'::timestamptz)::bigint, 'NS');

insert into public.bookmakers (id, name)
values
  (991001, 'Bounded Odds Book One'),
  (991002, 'Bounded Odds Book Two');

insert into public.bet_types (id, name)
values
  (991001, 'Asian Handicap'),
  (991002, 'Over/Under');

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
  (991001, 991001, 991001, 'Home -3.5', 1.95, '2099-08-30 12:00:00+00', '2099-08-30 12:01:00+00'),
  (991001, 991001, 991001, 'Away -3.5', 1.87, '2099-08-30 12:00:00+00', '2099-08-30 12:01:00+00'),
  (991001, 991001, 991002, 'Over 44.5', 1.91, '2099-08-30 12:00:00+00', '2099-08-30 12:01:00+00'),
  (991001, 991001, 991002, 'Under 44.5', 1.91, '2099-08-30 12:00:00+00', '2099-08-30 12:01:00+00'),
  (991001, 991002, 991001, 'Home -4.5', 1.91, '2099-08-30 12:05:00+00', '2099-08-30 12:06:00+00'),
  (991001, 991002, 991001, 'Away -4.5', 1.91, '2099-08-30 12:05:00+00', '2099-08-30 12:06:00+00'),
  (991001, 991002, 991002, 'Over 45.5', 1.91, '2099-08-30 12:05:00+00', '2099-08-30 12:06:00+00'),
  (991001, 991002, 991002, 'Under 45.5', 1.91, '2099-08-30 12:05:00+00', '2099-08-30 12:06:00+00');

insert into public.odds (
  game_id,
  bookmaker_id,
  bet_id,
  bet_value,
  odd,
  provider_updated_at,
  captured_at
)
select
  991002,
  991001,
  991001,
  outcome || ' -' || line::text,
  1.91,
  '2099-08-30 12:00:00+00'::timestamptz,
  '2099-08-30 12:01:00+00'::timestamptz
from generate_series(1, 1000) as lines(line)
cross join (values ('Home'), ('Away')) as outcomes(outcome);

select is(
  (select home_spread from public.get_game_consensus_odds(array[991001])),
  (-4)::numeric,
  'returns the median home spread for a requested game'
);
select is(
  (select total from public.get_game_consensus_odds(array[991001])),
  45::numeric,
  'returns the median total for a requested game'
);
select is(
  (select count(*)::integer from public.get_game_consensus_odds(array[991001])),
  1,
  'does not return games with substantial unrelated odds history'
);
select is(
  (select count(*)::integer from public.get_game_consensus_odds(array[]::integer[])),
  0,
  'returns no rows for an empty request'
);

select * from finish();
rollback;
