-- Compute graded closing odds only for explicitly requested completed games.

create or replace function public.get_game_betting_results(requested_game_ids integer[])
returns table (
  game_id integer,
  season integer,
  stage text,
  week text,
  game_date date,
  game_timestamp bigint,
  away_team_id integer,
  away_team_name text,
  home_team_id integer,
  home_team_name text,
  away_score integer,
  home_score integer,
  final_total integer,
  home_margin integer,
  closing_home_spread numeric,
  spread_bookmaker_count integer,
  spread_delta numeric,
  spread_result text,
  closing_total numeric,
  total_bookmaker_count integer,
  total_delta numeric,
  total_result text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with requested_games as (
    select distinct requested.game_id
    from unnest(coalesce(requested_game_ids, array[]::integer[])) as requested(game_id)
    where requested.game_id is not null
  ),
  eligible_games as (
    select games.*
    from public.games
    join requested_games on requested_games.game_id = games.id
    where games.status_short in ('FT', 'AOT')
      and games.away_total is not null
      and games.home_total is not null
  ),
  target_markets as (
    select
      max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
      max(id) filter (where name = 'Over/Under') as total_bet_id
    from public.bet_types
  ),
  market_rows as (
    select
      odds.game_id,
      odds.bookmaker_id,
      odds.bet_id,
      split_part(odds.bet_value, ' ', 1) as outcome,
      case
        when odds.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
          then substring(odds.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
        else null
      end as line,
      odds.odd,
      odds.provider_updated_at
    from public.odds
    join eligible_games on eligible_games.id = odds.game_id
    cross join target_markets
    where eligible_games.game_timestamp is not null
      and odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
      and odds.provider_updated_at <= to_timestamp(eligible_games.game_timestamp)
      and odds.odd is not null
  ),
  spread_pairs as (
    select
      home.game_id,
      home.bookmaker_id,
      abs(home.line) as line,
      home.line as home_spread,
      home.odd as home_odd,
      coalesce(same_line_away.odd, opposite_line_away.odd) as away_odd,
      home.provider_updated_at
    from market_rows home
    left join market_rows same_line_away
      on same_line_away.game_id = home.game_id
      and same_line_away.bookmaker_id = home.bookmaker_id
      and same_line_away.bet_id = home.bet_id
      and same_line_away.provider_updated_at = home.provider_updated_at
      and same_line_away.outcome = 'Away'
      and same_line_away.line = home.line
    left join market_rows opposite_line_away
      on opposite_line_away.game_id = home.game_id
      and opposite_line_away.bookmaker_id = home.bookmaker_id
      and opposite_line_away.bet_id = home.bet_id
      and opposite_line_away.provider_updated_at = home.provider_updated_at
      and opposite_line_away.outcome = 'Away'
      and opposite_line_away.line = -home.line
      and same_line_away.line is null
    cross join target_markets
    where home.bet_id = target_markets.spread_bet_id
      and home.outcome = 'Home'
      and home.line is not null
      and coalesce(same_line_away.line, opposite_line_away.line) is not null
  ),
  ranked_spreads as (
    select
      spread_pairs.*,
      row_number() over (
        partition by
          spread_pairs.game_id,
          spread_pairs.bookmaker_id,
          spread_pairs.provider_updated_at
        order by
          abs(spread_pairs.home_odd - spread_pairs.away_odd),
          abs(((spread_pairs.home_odd + spread_pairs.away_odd) / 2) - 1.91),
          abs(spread_pairs.line)
      ) as line_rank
    from spread_pairs
    where spread_pairs.home_odd is not null
      and spread_pairs.away_odd is not null
  ),
  bookmaker_spreads as (
    select distinct on (ranked_spreads.game_id, ranked_spreads.bookmaker_id)
      ranked_spreads.game_id,
      ranked_spreads.bookmaker_id,
      ranked_spreads.home_spread,
      ranked_spreads.provider_updated_at
    from ranked_spreads
    where ranked_spreads.line_rank = 1
    order by
      ranked_spreads.game_id,
      ranked_spreads.bookmaker_id,
      ranked_spreads.provider_updated_at desc
  ),
  spread_consensus as (
    select
      bookmaker_spreads.game_id,
      percentile_cont(0.5) within group (order by bookmaker_spreads.home_spread)::numeric as home_spread,
      count(*)::integer as spread_bookmaker_count
    from bookmaker_spreads
    group by bookmaker_spreads.game_id
  ),
  total_pairs as (
    select
      market_rows.game_id,
      market_rows.bookmaker_id,
      market_rows.line,
      market_rows.provider_updated_at,
      max(market_rows.odd) filter (where market_rows.outcome = 'Over') as over_odd,
      max(market_rows.odd) filter (where market_rows.outcome = 'Under') as under_odd
    from market_rows
    cross join target_markets
    where market_rows.bet_id = target_markets.total_bet_id
      and market_rows.line is not null
    group by
      market_rows.game_id,
      market_rows.bookmaker_id,
      market_rows.line,
      market_rows.provider_updated_at
  ),
  ranked_totals as (
    select
      total_pairs.*,
      row_number() over (
        partition by
          total_pairs.game_id,
          total_pairs.bookmaker_id,
          total_pairs.provider_updated_at
        order by
          abs(total_pairs.over_odd - total_pairs.under_odd),
          abs(((total_pairs.over_odd + total_pairs.under_odd) / 2) - 1.91),
          total_pairs.line
      ) as line_rank
    from total_pairs
    where total_pairs.over_odd is not null
      and total_pairs.under_odd is not null
  ),
  bookmaker_totals as (
    select distinct on (ranked_totals.game_id, ranked_totals.bookmaker_id)
      ranked_totals.game_id,
      ranked_totals.bookmaker_id,
      ranked_totals.line as total,
      ranked_totals.provider_updated_at
    from ranked_totals
    where ranked_totals.line_rank = 1
    order by
      ranked_totals.game_id,
      ranked_totals.bookmaker_id,
      ranked_totals.provider_updated_at desc
  ),
  total_consensus as (
    select
      bookmaker_totals.game_id,
      percentile_cont(0.5) within group (order by bookmaker_totals.total)::numeric as total,
      count(*)::integer as total_bookmaker_count
    from bookmaker_totals
    group by bookmaker_totals.game_id
  )
  select
    eligible_games.id as game_id,
    eligible_games.season,
    eligible_games.stage,
    eligible_games.week,
    eligible_games.game_date,
    eligible_games.game_timestamp,
    eligible_games.away_team_id,
    away_teams.name as away_team_name,
    eligible_games.home_team_id,
    home_teams.name as home_team_name,
    eligible_games.away_total as away_score,
    eligible_games.home_total as home_score,
    eligible_games.away_total + eligible_games.home_total as final_total,
    eligible_games.home_total - eligible_games.away_total as home_margin,
    spread_consensus.home_spread as closing_home_spread,
    spread_consensus.spread_bookmaker_count,
    case
      when spread_consensus.home_spread is null then null
      else eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread
    end as spread_delta,
    case
      when spread_consensus.home_spread is null then 'ungraded'
      when eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread > 0
        then 'home_cover'
      when eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread < 0
        then 'away_cover'
      else 'push'
    end as spread_result,
    total_consensus.total as closing_total,
    total_consensus.total_bookmaker_count,
    case
      when total_consensus.total is null then null
      else eligible_games.away_total + eligible_games.home_total - total_consensus.total
    end as total_delta,
    case
      when total_consensus.total is null then 'ungraded'
      when eligible_games.away_total + eligible_games.home_total > total_consensus.total then 'over'
      when eligible_games.away_total + eligible_games.home_total < total_consensus.total then 'under'
      else 'push'
    end as total_result
  from eligible_games
  join public.teams away_teams on away_teams.id = eligible_games.away_team_id
  join public.teams home_teams on home_teams.id = eligible_games.home_team_id
  left join spread_consensus on spread_consensus.game_id = eligible_games.id
  left join total_consensus on total_consensus.game_id = eligible_games.id
  order by eligible_games.game_timestamp desc, eligible_games.id desc;
$$;

revoke all on function public.get_game_betting_results(integer[]) from public;
grant execute on function public.get_game_betting_results(integer[]) to service_role;

comment on function public.get_game_betting_results(integer[]) is
  'Returns completed games graded against closing consensus after restricting odds scans to requested game IDs';
