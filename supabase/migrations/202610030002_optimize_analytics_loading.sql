create or replace function public.get_game_betting_results(requested_game_ids integer[])
returns table (
  game_id integer, season integer, stage text, week text, game_date date,
  game_timestamp bigint, away_team_id integer, away_team_name text,
  home_team_id integer, home_team_name text, away_score integer, home_score integer,
  final_total integer, home_margin integer, closing_home_spread numeric,
  spread_bookmaker_count integer, spread_delta numeric, spread_result text,
  closing_total numeric, total_bookmaker_count integer, total_delta numeric,
  total_result text
)
language sql stable security invoker set search_path = ''
as $$
  with eligible_games as materialized (
    select games.*
    from public.games
    where games.id = any(coalesce(requested_game_ids, array[]::integer[]))
      and games.status_short in ('FT', 'AOT')
      and games.away_total is not null and games.home_total is not null
  ),
  target_markets as materialized (
    select max(id) filter (where name = 'Asian Handicap') as spread_id,
      max(id) filter (where name = 'Over/Under') as total_id
    from public.bet_types
  ),
  market_rows as materialized (
    select odds.game_id, odds.bookmaker_id, odds.bet_id, odds.provider_updated_at,
      split_part(odds.bet_value, ' ', 1) as outcome,
      substring(odds.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric as line,
      odds.odd
    from public.odds
    join eligible_games on eligible_games.id = odds.game_id
    cross join target_markets
    where odds.game_id = any(coalesce(requested_game_ids, array[]::integer[]))
      and odds.bet_id in (target_markets.spread_id, target_markets.total_id)
      and odds.provider_updated_at <= to_timestamp(eligible_games.game_timestamp)
      and odds.odd is not null
      and odds.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
  ),
  -- Pair within line groups instead of repeatedly scanning market-row self-joins.
  spread_lines as (
    select game_id, bookmaker_id, provider_updated_at, abs(line) as line,
      array_agg(odd) filter (where outcome = 'Home' and line >= 0) as positive_home,
      array_agg(odd) filter (where outcome = 'Home' and line < 0) as negative_home,
      array_agg(odd) filter (where outcome = 'Away' and line >= 0) as positive_away,
      array_agg(odd) filter (where outcome = 'Away' and line < 0) as negative_away
    from market_rows
    cross join target_markets
    where bet_id = target_markets.spread_id and outcome in ('Home', 'Away')
    group by game_id, bookmaker_id, provider_updated_at, abs(line)
  ),
  spread_pairs as (
    select spread_lines.game_id, spread_lines.bookmaker_id,
      spread_lines.provider_updated_at, pair.home_spread, home_odd, away_odd
    from spread_lines
    cross join lateral (values
      (line, positive_home, coalesce(positive_away, negative_away)),
      (-line, negative_home, coalesce(negative_away, positive_away))
    ) pair(home_spread, home_prices, away_prices)
    cross join lateral unnest(pair.home_prices) prices_home(home_odd)
    cross join lateral unnest(pair.away_prices) prices_away(away_odd)
  ),
  bookmaker_spreads as materialized (
    select distinct on (game_id, bookmaker_id)
      game_id, bookmaker_id, home_spread
    from spread_pairs
    order by game_id, bookmaker_id, provider_updated_at desc,
      abs(home_odd - away_odd), abs(((home_odd + away_odd) / 2) - 1.91),
      abs(home_spread)
  ),
  total_lines as (
    select game_id, bookmaker_id, provider_updated_at, line,
      array_agg(odd) filter (where outcome = 'Over') as over_prices,
      array_agg(odd) filter (where outcome = 'Under') as under_prices
    from market_rows
    cross join target_markets
    where bet_id = target_markets.total_id and outcome in ('Over', 'Under')
    group by game_id, bookmaker_id, provider_updated_at, line
  ),
  total_pairs as (
    select game_id, bookmaker_id, provider_updated_at, line, over_odd, under_odd
    from total_lines
    cross join lateral unnest(over_prices) prices_over(over_odd)
    cross join lateral unnest(under_prices) prices_under(under_odd)
  ),
  bookmaker_totals as materialized (
    select distinct on (game_id, bookmaker_id) game_id, bookmaker_id, line as total
    from total_pairs
    order by game_id, bookmaker_id, provider_updated_at desc,
      abs(over_odd - under_odd), abs(((over_odd + under_odd) / 2) - 1.91), line
  ),
  spread_consensus as materialized (
    select game_id,
      percentile_cont(0.5) within group (order by home_spread)::numeric as home_spread,
      count(*)::integer as spread_bookmaker_count
    from bookmaker_spreads group by game_id
  ),
  total_consensus as materialized (
    select game_id,
      percentile_cont(0.5) within group (order by total)::numeric as total,
      count(*)::integer as total_bookmaker_count
    from bookmaker_totals group by game_id
  )
  select games.id, games.season, games.stage, games.week, games.game_date,
    games.game_timestamp, games.away_team_id, away_team.name,
    games.home_team_id, home_team.name, games.away_total, games.home_total,
    games.away_total + games.home_total, games.home_total - games.away_total,
    spread.home_spread, spread.spread_bookmaker_count,
    games.home_total - games.away_total + spread.home_spread,
    case when spread.home_spread is null then 'ungraded'
      when games.home_total - games.away_total + spread.home_spread > 0 then 'home_cover'
      when games.home_total - games.away_total + spread.home_spread < 0 then 'away_cover'
      else 'push' end,
    totals.total, totals.total_bookmaker_count,
    games.away_total + games.home_total - totals.total,
    case when totals.total is null then 'ungraded'
      when games.away_total + games.home_total > totals.total then 'over'
      when games.away_total + games.home_total < totals.total then 'under'
      else 'push' end
  from eligible_games games
  join public.teams away_team on away_team.id = games.away_team_id
  join public.teams home_team on home_team.id = games.home_team_id
  left join spread_consensus spread on spread.game_id = games.id
  left join total_consensus totals on totals.game_id = games.id
  order by games.game_timestamp desc, games.id desc;
$$;

revoke all on function public.get_game_betting_results(integer[]) from public;
grant execute on function public.get_game_betting_results(integer[]) to service_role;

create or replace function public.get_weekly_analysis_summaries(
  requested_season integer default null,
  requested_week text default null,
  before_created_at timestamptz default null,
  before_id uuid default null,
  page_size integer default 25
)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with default_season as (
    select greatest(2026, extract(year from current_date)::integer
      - case when extract(month from current_date) <= 2 then 1 else 0 end) as season
  ),
  selected_season as materialized (
    select coalesce(requested_season,
      (select season_year from public.league_seasons
        where is_current and season_year >= (select season from default_season)
        order by season_year desc limit 1),
      (select season from default_season)
    ) as season
  ),
  eligible as materialized (
    select id, season, stage, week, model_name, created_at,
      row_number() over (partition by season, stage, week order by created_at desc, id desc) = 1 as is_final
    from public.betting_analysis_runs
    where (stage is null or trim(stage) !~* '^pre[\s-]*season$')
      and season = (select season from selected_season)
  ),
  records as materialized (
    select suggestions.run_id,
      count(*)::integer as picks,
      count(*) filter (where result = 'win')::integer as wins,
      count(*) filter (where result = 'loss')::integer as losses,
      count(*) filter (where result = 'push')::integer as pushes,
      count(*) filter (where result = 'ungraded')::integer as pending
    from public.betting_suggestions suggestions
    join eligible on eligible.id = suggestions.run_id
    group by suggestions.run_id
  ),
  page as materialized (
    select eligible.*, coalesce(records.picks, 0) as picks,
      jsonb_build_object('wins', coalesce(wins, 0), 'losses', coalesce(losses, 0),
        'pushes', coalesce(pushes, 0), 'pending', coalesce(pending, 0)) as record
    from eligible left join records on records.run_id = eligible.id
    where (requested_week is null or week = requested_week)
      and (before_created_at is null
        or (created_at, id) < (before_created_at, before_id))
    order by created_at desc, id desc
    limit least(greatest(page_size, 1), 100) + 1
  )
  select jsonb_build_object(
    'runs', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'season', season, 'stage', stage, 'week', week,
      'model', model_name, 'createdAt', created_at, 'picks', picks, 'record', record, 'isFinal', is_final
    ) order by created_at desc, id desc) from page), '[]'::jsonb),
    'weeks', coalesce((select jsonb_agg(week order by newest desc)
      from (select week, max(created_at) as newest from eligible group by week) weeks), '[]'::jsonb),
    'record', (select jsonb_build_object(
      'wins', coalesce(sum(wins), 0), 'losses', coalesce(sum(losses), 0),
      'pushes', coalesce(sum(pushes), 0), 'pending', coalesce(sum(pending), 0)
    ) from records),
    'total', (select count(*) from eligible),
    'selectedSeason', (select season from selected_season)
  );
$$;

revoke all on function public.get_weekly_analysis_summaries(integer,text,timestamptz,uuid,integer) from public;
grant execute on function public.get_weekly_analysis_summaries(integer,text,timestamptz,uuid,integer) to service_role;
